(() => {
  // This only cancels shortcuts delivered to the public page. Access control
  // stays on the server; browser menus and already-open tools remain available.
  window.addEventListener("keydown", event => {
    if (window.location.pathname !== "/") return;
    const key = (event.key || "").toLowerCase();
    const toolKey = ["i", "j", "c", "k"].includes(key);
    const developerShortcut = event.key === "F12" || event.code === "F12"
      || (event.ctrlKey && event.shiftKey && !event.altKey && toolKey)
      || (event.metaKey && event.altKey && (toolKey || key === "u"))
      || (event.metaKey && event.shiftKey && key === "c");
    const sourceShortcut = (event.ctrlKey || event.metaKey)
      && !event.shiftKey && !event.altKey && key === "u";
    if (!developerShortcut && !sourceShortcut) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, { capture: true, passive: false });
})();
