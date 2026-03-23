const DEFAULT_POPUP_MS = 180;
const DEFAULT_DROPDOWN_MS = 140;

function clearMotionTimer(el) {
  if (!el || !el.__neoMotionTimer) return;
  clearTimeout(el.__neoMotionTimer);
  el.__neoMotionTimer = null;
}

function replayClass(el, cls) {
  if (!el) return;
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
}

export function openPopup(root, opts = {}) {
  if (!root) return;
  clearMotionTimer(root);
  const panel = opts.panel || root.querySelector("[data-popup-panel]");
  const backdrop = opts.backdrop || root.querySelector("[data-popup-backdrop]");

  root.classList.remove("hidden", "neo-popup-closing");
  root.setAttribute("aria-hidden", "false");
  panel?.classList.remove("neo-popup-panel-close");
  backdrop?.classList.remove("neo-popup-backdrop-close");

  replayClass(backdrop, "neo-popup-backdrop-open");
  replayClass(panel, "neo-popup-panel-open");

  if (opts.lockBody !== false) {
    document.body.style.overflow = "hidden";
  }
}

export function closePopup(root, opts = {}) {
  if (!root || root.classList.contains("hidden")) return;
  clearMotionTimer(root);
  const panel = opts.panel || root.querySelector("[data-popup-panel]");
  const backdrop = opts.backdrop || root.querySelector("[data-popup-backdrop]");
  const durationMs = opts.durationMs ?? DEFAULT_POPUP_MS;

  panel?.classList.remove("neo-popup-panel-open");
  backdrop?.classList.remove("neo-popup-backdrop-open");
  replayClass(panel, "neo-popup-panel-close");
  replayClass(backdrop, "neo-popup-backdrop-close");
  root.classList.add("neo-popup-closing");

  root.__neoMotionTimer = window.setTimeout(() => {
    root.classList.add("hidden");
    root.classList.remove("neo-popup-closing");
    root.setAttribute("aria-hidden", "true");
    panel?.classList.remove("neo-popup-panel-close");
    backdrop?.classList.remove("neo-popup-backdrop-close");
    if (opts.unlockBody !== false) {
      document.body.style.overflow = "";
    }
    root.__neoMotionTimer = null;
  }, durationMs);
}

export function openDropdown(panel, opts = {}) {
  if (!panel) return;
  clearMotionTimer(panel);
  panel.classList.remove("hidden", "neo-dropdown-closing", "neo-dropdown-close");
  replayClass(panel, "neo-dropdown-open");
  opts.trigger?.setAttribute("aria-expanded", "true");
}

export function closeDropdown(panel, opts = {}) {
  if (!panel || panel.classList.contains("hidden")) {
    opts.trigger?.setAttribute("aria-expanded", "false");
    return;
  }
  clearMotionTimer(panel);
  const durationMs = opts.durationMs ?? DEFAULT_DROPDOWN_MS;
  panel.classList.remove("neo-dropdown-open");
  replayClass(panel, "neo-dropdown-close");
  panel.classList.add("neo-dropdown-closing");
  opts.trigger?.setAttribute("aria-expanded", "false");
  panel.__neoMotionTimer = window.setTimeout(() => {
    panel.classList.add("hidden");
    panel.classList.remove("neo-dropdown-close", "neo-dropdown-closing");
    panel.__neoMotionTimer = null;
  }, durationMs);
}
