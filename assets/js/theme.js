(function () {
  var STORAGE_KEY = "neo-dex-theme";
  var root = document.documentElement;

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
    var toggles = document.querySelectorAll("#theme-toggle");
    toggles.forEach(function (btn) {
      btn.addEventListener("click", function () {
        var next = root.classList.contains("dark") ? "light" : "dark";
        window.__neoDexApplyTheme(next);
      });
    });
  });
})();
