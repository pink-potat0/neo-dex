(function () {
  var panel = document.querySelector('[data-send-panel="privacy"]');
  if (!panel) return;

  var input = document.getElementById("privacy-amount-input");
  var balanceEl = document.getElementById("privacy-balance-display");
  var maxBtn = panel.querySelector("[data-privacy-max]");
  var topupBtn = panel.querySelector("[data-privacy-topup]");

  function getBalance() {
    var raw = (balanceEl && balanceEl.textContent) || "0";
    var n = parseFloat(raw.replace(/,/g, "").trim());
    return Number.isFinite(n) ? n : 0;
  }

  if (maxBtn && input) {
    maxBtn.addEventListener("click", function () {
      var b = getBalance();
      input.value = b > 0 ? String(b) : "";
      input.focus();
    });
  }

  if (topupBtn) {
    topupBtn.addEventListener("click", function () {
      // Wire to wallet / shielding deposit when backend exists
      topupBtn.disabled = true;
      window.setTimeout(function () {
        topupBtn.disabled = false;
      }, 400);
    });
  }
})();
