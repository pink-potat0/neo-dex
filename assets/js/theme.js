(function () {
  var STORAGE_KEY = "neo-dex-theme";
  var root = document.documentElement;
  var CLEAN_ROUTE_MAP = {
    "/portfolio": "/pages/portfolio.html",
    "/swap": "/pages/swap.html",
    "/send": "/pages/send.html",
    "/bridge": "/pages/bridge.html"
  };

  function isLocalHost() {
    var host = String(window.location.hostname || "").toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0";
  }

  function rewriteLocalLinks() {
    if (!isLocalHost()) return;
    document.querySelectorAll("a[href]").forEach(function (link) {
      var href = link.getAttribute("href");
      if (!href || !CLEAN_ROUTE_MAP[href]) return;
      link.setAttribute("href", CLEAN_ROUTE_MAP[href]);
    });
  }

  function redirectLocalCleanRoute() {
    if (!isLocalHost()) return;
    var pathname = String(window.location.pathname || "");
    var normalized = pathname.length > 1 && pathname.endsWith("/")
      ? pathname.slice(0, -1)
      : pathname;
    var mapped = CLEAN_ROUTE_MAP[normalized];
    if (!mapped) return;
    var nextUrl = mapped + window.location.search + window.location.hash;
    window.location.replace(nextUrl);
  }

  function isMobileViewport() {
    return window.matchMedia && window.matchMedia("(max-width: 767px)").matches;
  }

  function updateKeyboardState() {
    if (!isMobileViewport()) {
      document.body.classList.remove("neo-keyboard-open");
      return;
    }
    var vv = window.visualViewport;
    if (!vv) return;
    var heightDelta = Math.max(0, window.innerHeight - vv.height);
    document.body.classList.toggle("neo-keyboard-open", heightDelta > 120);
  }

  function getPreferredTheme() {
    var saved = "";
    try {
      saved = localStorage.getItem(STORAGE_KEY) || "";
    } catch {}
    if (saved === "dark" || saved === "light") return saved;
    return window.matchMedia &&
      window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }

  function applyTheme(theme) {
    var dark = theme === "dark";
    root.classList.toggle("dark", dark);
    root.classList.toggle("light", !dark);
    var toggles = document.querySelectorAll("#theme-toggle");
    toggles.forEach(function (btn) {
      btn.textContent = dark ? "light_mode" : "dark_mode";
      btn.setAttribute("aria-label", dark ? "Switch to light mode" : "Switch to dark mode");
    });
  }

  window.__neoDexApplyTheme = function (theme) {
    applyTheme(theme);
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {}
  };

  applyTheme(getPreferredTheme());

  document.addEventListener("DOMContentLoaded", function () {
    rewriteLocalLinks();
    updateKeyboardState();
    var toggles = document.querySelectorAll("#theme-toggle");
    toggles.forEach(function (btn) {
      btn.addEventListener("click", function () {
        var next = root.classList.contains("dark") ? "light" : "dark";
        window.__neoDexApplyTheme(next);
      });
    });
    if (window.visualViewport) {
      window.visualViewport.addEventListener("resize", updateKeyboardState);
      window.visualViewport.addEventListener("scroll", updateKeyboardState);
    }
    window.addEventListener("resize", updateKeyboardState);
    document.addEventListener("focusin", function () {
      window.requestAnimationFrame(updateKeyboardState);
    });
    document.addEventListener("focusout", function () {
      window.setTimeout(updateKeyboardState, 80);
    });
  });

  redirectLocalCleanRoute();
})();
