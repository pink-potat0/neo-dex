(function () {
  const modal = document.getElementById("token-modal");
  if (!modal) return;

  const openers = document.querySelectorAll("[data-open-token-modal]");
  const closers = modal.querySelectorAll("[data-token-modal-close]");
  const backdrop = modal.querySelector("[data-token-modal-backdrop]");

  function open() {
    modal.classList.remove("hidden");
    modal.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
  }

  function close() {
    modal.classList.add("hidden");
    modal.setAttribute("aria-hidden", "true");
    document.body.style.overflow = "";
  }

  openers.forEach(function (el) {
    el.addEventListener("click", open);
  });
  closers.forEach(function (el) {
    el.addEventListener("click", function (e) {
      e.stopPropagation();
      close();
    });
  });
  if (backdrop) {
    backdrop.addEventListener("click", close);
  }
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && !modal.classList.contains("hidden")) close();
  });
})();
