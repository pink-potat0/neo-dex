(function () {
  var root = document.getElementById("send-page");
  if (!root) return;

  var tabs = root.querySelectorAll("[data-send-tab]");
  var panels = root.querySelectorAll("[data-send-panel]");

  function activate(mode) {
    tabs.forEach(function (t) {
      var active = t.getAttribute("data-send-tab") === mode;
      t.setAttribute("aria-selected", active ? "true" : "false");
      t.classList.toggle("bg-primary-container", active);
      t.classList.toggle("text-black", active);
      t.classList.toggle("bg-surface-container-low", !active);
      t.classList.toggle("text-on-surface", !active);
    });
    panels.forEach(function (p) {
      p.classList.toggle("hidden", p.getAttribute("data-send-panel") !== mode);
    });
  }

  tabs.forEach(function (t) {
    t.addEventListener("click", function () {
      activate(t.getAttribute("data-send-tab"));
    });
  });
})();
