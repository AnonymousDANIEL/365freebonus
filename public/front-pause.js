(() => {
  function pauseFrontPage() {
    if (window.location.pathname === "/" && !document.hidden) {
      debugger;
    }
  }

  window.addEventListener("keydown", event => {
    if (event.key === "F12") pauseFrontPage();
  }, true);

  // The browser can open DevTools before delivering a key event to the page.
  window.setInterval(pauseFrontPage, 250);
})();
