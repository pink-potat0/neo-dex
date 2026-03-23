import { PublicKey } from "@solana/web3.js";

const LS_WALLET = "neo-dex-wallet-adapter";
const LS_WALLET_PK = "neo-dex-wallet-pk";
/** After explicit disconnect, skip `onlyIfTrusted` reconnect until user connects again. */
const SS_SKIP_SILENT = "neo-dex-skip-silent-reconnect";
let warmedPageLinks = false;

function getPhantomProvider() {
  const viaPhantom = window.phantom?.solana;
  if (viaPhantom?.isPhantom) return viaPhantom;
  const s = window.solana;
  if (s?.isPhantom) return s;
  return null;
}

const ADAPTERS = [
  {
    id: "phantom",
    name: "Phantom",
    get: getPhantomProvider,
  },
  {
    id: "solflare",
    name: "Solflare",
    get: () => (window.solflare?.isSolflare ? window.solflare : null),
  },
  {
    id: "backpack",
    name: "Backpack",
    get: () =>
      window.backpack?.isBackpack
        ? window.backpack
        : window.backpack?.solana || null,
  },
];

let provider = null;
let publicKey = null;
const providerListeners = new WeakMap();

function emitWalletChanged() {
  try {
    window.dispatchEvent(
      new CustomEvent("neo-dex:wallet-changed", {
        detail: { wallet: publicKey ? publicKey.toBase58() : "" },
      })
    );
  } catch (_) {}
}

export function fmtShortPk(pk) {
  if (!pk) return "";
  const s = pk.toBase58();
  return s.slice(0, 4) + "…" + s.slice(-4);
}

export function getPublicKey() {
  return publicKey;
}

function fmtShortPkString(raw) {
  const s = String(raw || "").trim();
  if (s.length < 8) return "";
  return s.slice(0, 4) + "â€¦" + s.slice(-4);
}

function readCachedWalletPk() {
  try {
    return localStorage.getItem(LS_WALLET_PK) || "";
  } catch (_) {
    return "";
  }
}

function writeCachedWalletPk(pk) {
  try {
    if (pk) localStorage.setItem(LS_WALLET_PK, pk);
    else localStorage.removeItem(LS_WALLET_PK);
  } catch (_) {
    /* ignore */
  }
}

export function getProvider() {
  return provider;
}

export function listInstalledWallets() {
  return ADAPTERS.map((a) => ({
    id: a.id,
    name: a.name,
    adapter: a.get(),
  })).filter((x) => x.adapter);
}

function orderedAdapters() {
  const pref = localStorage.getItem(LS_WALLET);
  const rest = ADAPTERS.filter((a) => a.id !== pref);
  const first = ADAPTERS.find((a) => a.id === pref);
  return pref && first ? [first, ...rest] : [...ADAPTERS];
}

function detectAdapterId(adapter) {
  if (!adapter) return null;
  if (adapter?.isSolflare) return "solflare";
  if (adapter?.isPhantom) return "phantom";
  if (adapter?.isBackpack || window.backpack?.solana === adapter) {
    return "backpack";
  }
  const found = ADAPTERS.find((a) => a.get() === adapter);
  return found?.id || null;
}

function readPk(p) {
  const pk = p?.publicKey;
  if (!pk) return null;
  return pk instanceof PublicKey ? pk : new PublicKey(pk.toString());
}

/** Wallet page chip (#home-address-chip) must mirror session state — not only async dashboard refresh. */
function syncHomePageWalletChip() {
  const el = document.getElementById("home-address-chip");
  if (!el) return;
  const cached = fmtShortPkString(readCachedWalletPk());
  el.textContent = publicKey ? fmtShortPk(publicKey) : cached || "Not connected";
}

function warmPageNavigationLinks() {
  if (warmedPageLinks || typeof document === "undefined") return;
  warmedPageLinks = true;
  const hrefs = new Set();
  document.querySelectorAll("a[href]").forEach((anchor) => {
    const href = anchor.getAttribute("href");
    if (!href || href.startsWith("#")) return;
    try {
      const url = new URL(href, window.location.href);
      if (url.origin !== window.location.origin) return;
      if (!/\.html?$/i.test(url.pathname)) return;
      hrefs.add(url.href);
    } catch (_) {
      /* ignore malformed href */
    }
  });
  const run = () => {
    hrefs.forEach((href) => {
      const link = document.createElement("link");
      link.rel = "prefetch";
      link.as = "document";
      link.href = href;
      document.head.appendChild(link);
    });
  };
  if ("requestIdleCallback" in window) {
    window.requestIdleCallback(run, { timeout: 1200 });
  } else {
    setTimeout(run, 350);
  }
}

function unbindProviderListeners(p) {
  if (!p) return;
  const saved = providerListeners.get(p);
  const onDisconnect = saved?.onDisconnect;
  const onAccountChanged = saved?.onAccountChanged;
  try {
    if (onDisconnect) {
      p.removeListener?.("disconnect", onDisconnect);
      p.off?.("disconnect", onDisconnect);
    }
  } catch (_) {}
  try {
    if (onAccountChanged) {
      p.removeListener?.("accountChanged", onAccountChanged);
      p.off?.("accountChanged", onAccountChanged);
    }
  } catch (_) {}
  providerListeners.delete(p);
}

function bindProvider(p, onChange) {
  if (!p) return;
  unbindProviderListeners(p);

  const onDisconnect = () => {
    provider = null;
    publicKey = null;
    writeCachedWalletPk("");
    try {
      sessionStorage.setItem(SS_SKIP_SILENT, "1");
    } catch (_) {}
    syncHomePageWalletChip();
    onChange?.();
  };
  const onAccountChanged = (pk) => {
    if (pk) {
      publicKey = new PublicKey(pk.toString());
      writeCachedWalletPk(publicKey.toBase58());
    } else {
      publicKey = null;
      provider = null;
      writeCachedWalletPk("");
    }
    syncHomePageWalletChip();
    onChange?.();
  };

  providerListeners.set(p, { onDisconnect, onAccountChanged });

  try {
    p.on?.("disconnect", onDisconnect);
  } catch (_) {}
  try {
    p.on?.("accountChanged", onAccountChanged);
  } catch (_) {}
}

export function setConnectedWallet(p, adapterId, onChange) {
  provider = p;
  publicKey = readPk(p);
  if (adapterId) localStorage.setItem(LS_WALLET, adapterId);
  writeCachedWalletPk(publicKey?.toBase58?.() || "");
  bindProvider(p, onChange);
  syncHomePageWalletChip();
  emitWalletChanged();
  onChange?.();
}

export async function trySilentReconnect(onChange) {
  try {
    if (sessionStorage.getItem(SS_SKIP_SILENT) === "1") return false;
  } catch (_) {
    /* private mode */
  }
  const pref = localStorage.getItem(LS_WALLET);
  if (pref) {
    const preferred = ADAPTERS.find((a) => a.id === pref);
    const p = preferred?.get?.();
    if (!p) return false;
    try {
      await p.connect({ onlyIfTrusted: true });
      setConnectedWallet(p, pref, onChange);
      return true;
    } catch (_) {
      return false;
    }
  }
  for (const def of orderedAdapters()) {
    const p = def.get();
    if (!p) continue;
    try {
      await p.connect({ onlyIfTrusted: true });
      setConnectedWallet(p, def.id, onChange);
      return true;
    } catch (_) {
      /* not trusted yet */
    }
  }
  return false;
}

export async function connectInteractive(adapter, onChange, adapterId = null) {
  await adapter.connect();
  try {
    sessionStorage.removeItem(SS_SKIP_SILENT);
  } catch (_) {}
  const id =
    adapterId ||
    detectAdapterId(adapter) ||
    localStorage.getItem(LS_WALLET) ||
    "phantom";
  setConnectedWallet(adapter, id, onChange);
}

export async function disconnectWallet(onChange) {
  const p = provider;
  unbindProviderListeners(p);
  try {
    await p?.disconnect?.();
  } catch (_) {}
  provider = null;
  publicKey = null;
  writeCachedWalletPk("");
  try {
    sessionStorage.setItem(SS_SKIP_SILENT, "1");
  } catch (_) {}
  syncHomePageWalletChip();
  emitWalletChanged();
  onChange?.();
}

/** Short address + menu hint when connected (matches wireWalletConnectButton). */
export function walletConnectButtonLabel() {
  return publicKey ? fmtShortPk(publicKey) + " ▾" : "Connect";
}

export function refreshWalletConnectButtonLabel(btn) {
  if (btn) {
    const live = walletConnectButtonLabel();
    if (live !== "Connect") {
      btn.textContent = live;
      return;
    }
    const cached = fmtShortPkString(readCachedWalletPk());
    btn.textContent = cached ? cached + " â–¾" : live;
  }
}

function ensureWalletMenuShell(btn) {
  const existing = btn.closest("[data-neo-wallet-shell]");
  if (existing) {
    const menu = existing.querySelector("[data-neo-wallet-menu]");
    return { shell: existing, menu };
  }
  const shell = document.createElement("div");
  shell.dataset.neoWalletShell = "1";
  shell.className = "relative inline-block text-left";
  btn.parentNode.insertBefore(shell, btn);
  shell.appendChild(btn);

  const menu = document.createElement("div");
  menu.dataset.neoWalletMenu = "1";
  menu.setAttribute("role", "menu");
  menu.className =
    "absolute right-0 top-full z-[60] mt-1 hidden min-w-[11rem] border-4 border-black bg-white py-1 shadow-[4px_4px_0_0_#000]";
  menu.innerHTML =
    '<button type="button" data-neo-action="change" role="menuitem" class="block w-full px-3 py-2 text-left text-xs font-bold uppercase tracking-tight text-black hover:bg-primary-container">Change wallet</button>' +
    '<button type="button" data-neo-action="disconnect" role="menuitem" class="block w-full border-t-2 border-black px-3 py-2 text-left text-xs font-bold uppercase tracking-tight text-black hover:bg-surface-container-low">Disconnect</button>';
  shell.appendChild(menu);

  return { shell, menu };
}

function ensurePicker() {
  let root = document.getElementById("neo-wallet-picker");
  if (root) return root;
  root = document.createElement("div");
  root.id = "neo-wallet-picker";
  root.className = "fixed inset-0 z-[100] hidden";
  root.innerHTML =
    '<div class="neo-wp-back absolute inset-0 bg-black/60 backdrop-blur-sm"></div>' +
    '<div class="relative flex min-h-full items-center justify-center p-4">' +
    '<div class="w-full max-w-sm border-4 border-black bg-white p-6 shadow-[8px_8px_0_0_#000]">' +
    '<div class="mb-4 flex items-center justify-between border-b-4 border-black pb-3">' +
    '<h2 class="text-xl font-bold tracking-tight">Connect Wallet</h2>' +
    '<button type="button" class="neo-wp-close flex h-10 w-10 items-center justify-center rounded-full border-2 border-black text-xl font-bold leading-none hover:bg-black hover:text-white">×</button>' +
    '</div>' +
    '<p class="mb-4 text-sm font-medium text-outline">Pick an installed wallet.</p>' +
    '<div id="neo-wallet-picker-list" class="flex flex-col gap-2"></div>' +
    '</div></div>';
  document.body.appendChild(root);
  return root;
}

export function closeWalletPicker() {
  const root = document.getElementById("neo-wallet-picker");
  if (root) {
    root.classList.add("hidden");
    document.body.style.overflow = "";
  }
}

export function openWalletPicker(onPicked) {
  const root = ensurePicker();
  const list = root.querySelector("#neo-wallet-picker-list");
  list.innerHTML = "";

  const close = () => {
    closeWalletPicker();
  };

  const back = root.querySelector(".neo-wp-back");
  const xbtn = root.querySelector(".neo-wp-close");
  if (back) back.onclick = close;
  if (xbtn) xbtn.onclick = close;

  const installed = listInstalledWallets();
  if (installed.length === 0) {
    list.innerHTML =
      '<p class="border-2 border-black bg-surface-container-low p-4 text-xs font-bold uppercase leading-relaxed">No Solana wallet detected. Install <a class="underline" href="https://phantom.app" target="_blank" rel="noopener">Phantom</a>, <a class="underline" href="https://solflare.com" target="_blank" rel="noopener">Solflare</a>, or <a class="underline" href="https://backpack.app" target="_blank" rel="noopener">Backpack</a>.</p>';
  } else {
    installed.forEach(({ id, name, adapter }) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className =
        "w-full border-2 border-black bg-white px-3 py-3 text-left transition-colors hover:bg-primary-container";
      const leftIcon = document.createElement("span");
      leftIcon.className =
        "material-symbols-outlined mr-3 inline-flex h-7 w-7 items-center justify-center rounded-md bg-primary-container text-black align-middle text-base";
      leftIcon.textContent = "account_balance_wallet";
      const label = document.createElement("span");
      label.className = "align-middle text-2xl font-bold tracking-tight";
      label.textContent = name;
      const detected = document.createElement("span");
      detected.className =
        "float-right align-middle text-sm font-semibold text-outline";
      detected.textContent = "Detected";
      btn.appendChild(leftIcon);
      btn.appendChild(label);
      btn.appendChild(detected);
      btn.addEventListener("click", async function () {
        try {
          localStorage.setItem(LS_WALLET, id);
          await connectInteractive(adapter, onPicked, id);
          closeWalletPicker();
        } catch (e) {
          const err = document.createElement("p");
          err.className = "mt-2 text-[10px] font-bold uppercase text-error";
          err.textContent = (e && e.message) || "Connection failed";
          list.appendChild(err);
        }
      });
      list.appendChild(btn);
    });
  }

  root.classList.remove("hidden");
  document.body.style.overflow = "hidden";
}

/**
 * Wire #wallet-connect: silent reconnect on load; when connected, click opens
 * Disconnect / Change wallet menu; when disconnected, connect flow (silent or picker).
 */
export async function wireWalletConnectButton(onChange) {
  const btn = document.getElementById("wallet-connect");
  if (!btn || btn.dataset.neoDexWallet === "1") return;
  btn.dataset.neoDexWallet = "1";
  syncHomePageWalletChip();
  refreshWalletConnectButtonLabel(btn);
  warmPageNavigationLinks();

  const { shell, menu } = ensureWalletMenuShell(btn);

  function closeMenu() {
    menu.classList.add("hidden");
    btn.setAttribute("aria-expanded", "false");
  }

  function openMenu() {
    menu.classList.remove("hidden");
    btn.setAttribute("aria-expanded", "true");
  }

  function onDocumentClick(e) {
    if (!shell.contains(e.target)) closeMenu();
  }
  document.addEventListener("click", onDocumentClick);

  function onDocumentKey(e) {
    if (e.key === "Escape") closeMenu();
  }
  document.addEventListener("keydown", onDocumentKey);

  menu.querySelector("[data-neo-action='disconnect']")?.addEventListener(
    "click",
    async function (e) {
      e.preventDefault();
      e.stopPropagation();
      closeMenu();
      await disconnectWallet(onChange);
      refreshWalletConnectButtonLabel(btn);
    }
  );

  menu.querySelector("[data-neo-action='change']")?.addEventListener(
    "click",
    async function (e) {
      e.preventDefault();
      e.stopPropagation();
      closeMenu();
      await disconnectWallet(onChange);
      refreshWalletConnectButtonLabel(btn);
      const afterPick = () => {
        refreshWalletConnectButtonLabel(btn);
        onChange?.();
      };
      queueMicrotask(() => openWalletPicker(afterPick));
    }
  );

  const ok = await trySilentReconnect(onChange);
  refreshWalletConnectButtonLabel(btn);

  btn.setAttribute("aria-haspopup", "true");
  btn.setAttribute("aria-expanded", "false");

  btn.addEventListener("click", async function (e) {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    if (publicKey) {
      if (menu.classList.contains("hidden")) openMenu();
      else closeMenu();
      return;
    }
    try {
      sessionStorage.removeItem(SS_SKIP_SILENT);
    } catch (_) {}
    const silent = await trySilentReconnect(onChange);
    if (silent) {
      refreshWalletConnectButtonLabel(btn);
      onChange?.();
      return;
    }
    /** Defer so this click cannot interact with picker/backdrop in the same event turn. */
    queueMicrotask(() => {
      openWalletPicker(() => {
        refreshWalletConnectButtonLabel(btn);
        onChange?.();
      });
    });
  });
}
