(() => {
  const pausedPath = "/page-paused.html";
  // The browser controls its own tools. Only act on shortcuts delivered to a
  // public page, never on the login or admin interface.
  window.addEventListener("keydown", event => {
    const key = (event.key || "").toLowerCase();
    const toolKey = ["i", "j", "c", "k"].includes(key);
    const developerShortcut = event.key === "F12" || event.code === "F12"
      || (event.ctrlKey && event.shiftKey && !event.altKey && toolKey)
      || (event.metaKey && event.altKey && (toolKey || key === "u"))
      || (event.metaKey && event.shiftKey && key === "c");
    const sourceShortcut = (event.ctrlKey || event.metaKey)
      && !event.shiftKey && !event.altKey && key === "u";
    if (!developerShortcut && !sourceShortcut) return;
    const path = window.location.pathname;
    if (path !== "/" && path !== pausedPath && !document.querySelector(".public-site")) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (path !== pausedPath) window.location.assign(pausedPath);
  }, { capture: true, passive: false });
})();
