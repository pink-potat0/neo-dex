(function () {
  var input = document.getElementById("bridge-amount");
  if (!input) return;
  input.addEventListener("input", function () {
    var v = input.value;
    var out = "";
    var dot = false;
    for (var i = 0; i < v.length; i++) {
      var c = v.charAt(i);
      if (c >= "0" && c <= "9") out += c;
      else if (c === "." && !dot) {
        out += ".";
        dot = true;
      }
    }
    if (out !== v) input.value = out;
  });
  document.querySelectorAll("[data-bridge-preset]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      input.value = btn.getAttribute("data-bridge-preset") || "";
      input.focus();
    });
  });
})();
