"""Build and install the local ClashLegends macOS app."""
import argparse
from pathlib import Path
import plistlib
import struct
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
IDENTIFIER = "local.clashlegends.developer"
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--directory", type=Path, default=Path.home() / "Desktop")
destination = parser.parse_args().directory.resolve() / "ClashLegends.app"
if destination.exists():
    plist = destination / "Contents/Info.plist"
    if not plist.is_file() or plistlib.loads(plist.read_bytes()).get("CFBundleIdentifier") != IDENTIFIER:
        raise SystemExit(f"{destination} 已存在，请为原应用保留该位置，或用 --directory 指定安装目录。")
destination.parent.mkdir(parents=True, exist_ok=True)
with tempfile.TemporaryDirectory() as temp:
    staging = Path(temp)
    contents = staging / "ClashLegends.app/Contents"
    executable = contents / "MacOS/ClashLegends"
    executable.parent.mkdir(parents=True)
    resources = contents / "Resources"
    resources.mkdir()
    icons = bytearray()
    for side, tag in [(32, b"ic11"), (64, b"ic12"), (128, b"ic07"), (256, b"ic08"), (512, b"ic09")]:
        png = staging / f"icon-{side}.png"
        subprocess.run(["/usr/bin/sips", "-z", str(side), str(side), str(ROOT / "web/public/media/game-icon-512.png"),
                        "--out", png], check=True, stdout=subprocess.DEVNULL)
        data = png.read_bytes()
        icons.extend(tag + struct.pack(">I", 8 + len(data)) + data)
    (resources / "GameIcon.icns").write_bytes(b"icns" + struct.pack(">I", 8 + len(icons)) + icons)
    subprocess.run(["/usr/bin/xcrun", "swiftc", "-swift-version", "5", "-O", "-parse-as-library", "-module-cache-path",
                    str(ROOT / ".local/desktop/swift-cache"), "-o", executable, ROOT / "tools/macos/Game.swift"], check=True)
    plist = dict(CFBundleIdentifier=IDENTIFIER, CFBundleName="ClashLegends", CFBundleExecutable="ClashLegends",
                 CFBundlePackageType="APPL", CFBundleIconFile="GameIcon", CFBundleVersion="1",
                 CFBundleShortVersionString="1.0", NSHighResolutionCapable=True, ClashProjectPath=str(ROOT),
                 NSAppTransportSecurity={"NSAllowsLocalNetworking": True})
    (contents / "Info.plist").write_bytes(plistlib.dumps(plist))
    subprocess.run(["/usr/bin/codesign", "--force", "--sign", "-", contents.parent], check=True)
    subprocess.run(["/usr/bin/ditto", contents.parent, destination], check=True)
print(destination)
