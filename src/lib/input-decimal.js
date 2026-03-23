/**
 * Keep only digits and a single `.`; cap fractional length. For amount fields.
 * @param {HTMLInputElement} el
 * @param {{ maxDecimals?: number }} [opts]
 */
export function bindDecimalInput(el, opts = {}) {
  if (!el) return;
  const maxDecimals =
    typeof opts.maxDecimals === "number" && opts.maxDecimals >= 0
      ? opts.maxDecimals
      : 18;

  function normalize() {
    let v = el.value.replace(/[^0-9.]/g, "");
    const dot = v.indexOf(".");
    if (dot !== -1) {
      v =
        v.slice(0, dot + 1) +
        v
          .slice(dot + 1)
          .replace(/\./g, "")
          .replace(/[^0-9]/g, "");
      const parts = v.split(".");
      if (parts[1] != null && parts[1].length > maxDecimals) {
        v = parts[0] + "." + parts[1].slice(0, maxDecimals);
      }
    }
    if (v !== el.value) el.value = v;
  }

  el.addEventListener("input", normalize);
}
