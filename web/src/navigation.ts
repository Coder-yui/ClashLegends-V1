import { useSyncExternalStore } from "react";

function subscribe(fn: () => void) {
  window.addEventListener("popstate", fn);
  return () => window.removeEventListener("popstate", fn);
}
export function useLocation() {
  return useSyncExternalStore(subscribe, () => location.href);
}
export function navigate(url: string) {
  const dest = new URL(url, location.href);
  if (dest.href === location.href) return;
  history.pushState(null, "", dest.href);
  window.dispatchEvent(new PopStateEvent("popstate"));
  window.scrollTo(0, 0);
}
export function internalLink(event: MouseEvent) {
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  )
    return;
  const a =
    event.target instanceof Element
      ? event.target.closest<HTMLAnchorElement>("a[href]")
      : null;
  if (
    a &&
    a.origin === location.origin &&
    a.pathname.startsWith("/play/") &&
    (!a.target || a.target === "_self") &&
    !a.hasAttribute("download")
  )
    return a;
}
export function installNavigation() {
  document.addEventListener("click", (e) => {
    const a = internalLink(e);
    if (a) {
      e.preventDefault();
      navigate(a.href);
    }
  });
}
