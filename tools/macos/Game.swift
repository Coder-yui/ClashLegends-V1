import AppKit
import WebKit

let lobby = URL(string: "http://127.0.0.1:4317/play/")!
let project = URL(fileURLWithPath: Bundle.main.object(forInfoDictionaryKey: "ClashProjectPath") as! String)
let logs = project.appendingPathComponent(".local/desktop")

struct LaunchError: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

final class LocalLogin: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }

    func cookie() async throws -> HTTPCookie {
        let entries = try String(contentsOf: project.appendingPathComponent(".local/accounts/login-keys.txt"), encoding: .utf8)
        guard let row = entries.split(separator: "\n").first(where: { $0.hasPrefix("admin\t") }) else {
            throw LaunchError("本机账号文件中缺少 admin。")
        }
        let url = URL(string: "/api/account/login", relativeTo: lobby)!.absoluteURL
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["name": "admin", "key": String(row.dropFirst(6))])
        let config = URLSessionConfiguration.ephemeral
        config.connectionProxyDictionary = [:]
        let session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        let (_, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200,
              let header = http.value(forHTTPHeaderField: "Set-Cookie"),
              let cookie = HTTPCookie.cookies(withResponseHeaderFields: ["Set-Cookie": header], for: url)
                .first(where: { $0.name == "clash_account" && $0.isHTTPOnly }) else {
            throw LaunchError("本地大厅未能登录 admin，请检查账号文件和启动日志。")
        }
        return cookie
    }
}

func runLocalTool(_ name: String) throws {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/python3")
    process.arguments = [project.appendingPathComponent("tools/macos/" + name + ".py").path]
    let output = Pipe()
    process.standardError = output
    process.standardOutput = output
    try process.run()
    let details = output.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    try details.write(to: logs.appendingPathComponent(name + ".log"), options: .atomic)
    if process.terminationStatus != 0 {
        let last = String(decoding: details, as: UTF8.self).split(separator: "\n").last
        throw LaunchError(last.map(String.init) ?? "本地开发服务启动失败。")
    }
}

@MainActor
final class Game: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKDownloadDelegate, WKUIDelegate {
    var window: NSWindow!
    var web: WKWebView!
    var checkingLogin = true
    let notice = NSTextField(labelWithString: "正在启动本地开发服务…")

    func applicationDidFinishLaunching(_ notification: Notification) {
        let menu = NSMenu()
        let appMenu = NSMenu()
        let pair = appMenu.addItem(withTitle: "配对我的 iPhone…", action: #selector(pairPhone(_:)), keyEquivalent: "")
        pair.target = self
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "退出 ClashLegends", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        menu.addItem(withTitle: "ClashLegends", action: nil, keyEquivalent: "").submenu = appMenu
        let edit = NSMenu(title: "编辑")
        for (title, action, key) in [("剪切", "cut:", "x"), ("复制", "copy:", "c"), ("粘贴", "paste:", "v"), ("全选", "selectAll:", "a")] {
            edit.addItem(withTitle: title, action: Selector(action), keyEquivalent: key)
        }
        menu.addItem(withTitle: "编辑", action: nil, keyEquivalent: "").submenu = edit
        NSApp.mainMenu = menu
        window = NSWindow(contentRect: NSMakeRect(0, 0, 1000, 740),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "ClashLegends"
        window.collectionBehavior = [.fullScreenPrimary]
        window.center()
        window.setFrameAutosaveName("ClashLegendsGame")
        let config = WKWebViewConfiguration()
        if #available(macOS 12.3, *) { config.preferences.isElementFullscreenEnabled = true }
        web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = self
        web.uiDelegate = self
        window.contentView = web
        notice.translatesAutoresizingMaskIntoConstraints = false
        web.addSubview(notice)
        NSLayoutConstraint.activate([notice.centerXAnchor.constraint(equalTo: web.centerXAnchor),
                                     notice.centerYAnchor.constraint(equalTo: web.centerYAnchor)])
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        Task {
            do {
                try await Task.detached { try runLocalTool("start_lobby") }.value
                let cookie = try await LocalLogin().cookie()
                await web.configuration.websiteDataStore.httpCookieStore.setCookie(cookie)
                web.load(URLRequest(url: lobby))
            } catch { showError(error) }
        }
    }

    @objc func pairPhone(_ sender: Any?) {
        Task {
            do {
                try await Task.detached { try runLocalTool("phone") }.value
                let file = project.appendingPathComponent(".local/phone/ClashLegends.mobileconfig")
                NSWorkspace.shared.activateFileViewerSelecting([file])
            } catch {
                let alert = NSAlert()
                alert.messageText = "无法生成 iPhone 安装文件"
                alert.informativeText = error.localizedDescription
                _ = await alert.beginSheetModal(for: window)
            }
        }
    }

    func showError(_ error: Error) {
        notice.stringValue = "大厅启动失败"
        let alert = NSAlert()
        alert.messageText = "无法打开本地大厅"
        alert.informativeText = error.localizedDescription
        alert.runModal()
        NSApp.terminate(nil)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard checkingLogin, webView.url == lobby else { return }
        checkingLogin = false
        Task {
            do {
                let result = try await web.callAsyncJavaScript("""
                    const response = await fetch('/api/session', {cache: 'no-store'});
                    const session = await response.json();
                    return session.role === 'admin' && session.name === 'admin';
                    """, arguments: [:], in: nil, contentWorld: .page)
                guard result as? Bool == true else { throw LaunchError("游戏窗口未取得管理员会话。") }
                notice.removeFromSuperview()
                try "admin 会话已验证 · \(Date())\n".write(to: logs.appendingPathComponent("window.log"),
                                                     atomically: true, encoding: .utf8)
            } catch { showError(error) }
        }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if checkingLogin { showError(error) }
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if action.shouldPerformDownload { decisionHandler(.download); return }
        guard let url = action.request.url, url.scheme == lobby.scheme,
              url.host == lobby.host, url.port == lobby.port else {
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse,
                  suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = suggestedFilename
        panel.beginSheetModal(for: window) { result in completionHandler(result == .OK ? panel.url : nil) }
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.beginSheetModal(for: window) { result in completionHandler(result == .OK ? panel.urls : nil) }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        window.makeKeyAndOrderFront(nil)
        return true
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

@main
struct Launcher {
    @MainActor static func main() {
        let app = NSApplication.shared
        let game = Game()
        app.setActivationPolicy(.regular)
        app.delegate = game
        withExtendedLifetime(game) { app.run() }
    }
}
