import {
  PublicKey,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";

const LS_WALLET = "neo-dex-wallet-adapter";
const LS_WALLET_PK = "neo-dex-wallet-pk";
/** After explicit disconnect, skip silent reconnect until user connects again. */
const SS_SKIP_SILENT = "neo-dex-skip-silent-reconnect";
const WALLET_STANDARD_APP_READY_EVENT = "wallet-standard:app-ready";
const WALLET_STANDARD_REGISTER_EVENT = "wallet-standard:register-wallet";
const DEFAULT_SOLANA_CHAIN = "solana:mainnet";

let warmedPageLinks = false;
let walletStandardBootstrapped = false;

const standardWalletRegistry = new Map();
const standardWalletAdapters = new WeakMap();

function getPhantomProvider() {
  const viaPhantom = window.phantom?.solana;
  if (viaPhantom?.isPhantom) return viaPhantom;
  const injected = window.solana;
  if (injected?.isPhantom) return injected;
  return null;
}

const LEGACY_ADAPTERS = [
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
  return s.slice(0, 4) + "..." + s.slice(-4);
}

export function getPublicKey() {
  return publicKey;
}

function fmtShortPkString(raw) {
  const s = String(raw || "").trim();
  if (s.length < 8) return "";
  return s.slice(0, 4) + "..." + s.slice(-4);
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

function readStoredWalletId() {
  try {
    return localStorage.getItem(LS_WALLET) || "";
  } catch (_) {
    return "";
  }
}

export function getProvider() {
  return provider;
}

function normalizeWalletName(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function walletIdFromName(name) {
  const raw = String(name || "").trim();
  if (!raw) return "wallet";
  const lower = raw.toLowerCase();
  if (lower.includes("jupiter")) return "jupiter";
  return lower.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "wallet";
}

function toUint8Array(value) {
  if (!value) return null;
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (Array.isArray(value)) return Uint8Array.from(value);
  return null;
}

function readPk(p) {
  const pk = p?.publicKey;
  if (!pk) return null;
  if (pk instanceof PublicKey) return pk;
  if (pk?.toBytes) return new PublicKey(pk.toBytes());
  return new PublicKey(pk.toString());
}

function isSolanaChain(chain) {
  return String(chain || "").startsWith("solana:");
}

function pickSolanaChain(account, wallet) {
  const accountChains = Array.isArray(account?.chains)
    ? account.chains
    : [];
  const walletChains = Array.isArray(wallet?.chains) ? wallet.chains : [];
  return (
    accountChains.find(isSolanaChain) ||
    walletChains.find(isSolanaChain) ||
    DEFAULT_SOLANA_CHAIN
  );
}

function getStandardAccountPublicKey(account) {
  if (!account) return null;
  if (account.address) return new PublicKey(account.address);
  const bytes = toUint8Array(account.publicKey);
  return bytes ? new PublicKey(bytes) : null;
}

function getStandardAccountAddress(account) {
  if (account?.address) return account.address;
  const pk = getStandardAccountPublicKey(account);
  return pk ? pk.toBase58() : "";
}

function pickStandardAccount(wallet, accounts = wallet?.accounts) {
  if (!Array.isArray(accounts) || accounts.length === 0) return null;
  return (
    accounts.find((account) =>
      Array.isArray(account?.chains)
        ? account.chains.some(isSolanaChain)
        : Boolean(
            account?.address ||
              account?.publicKey ||
              wallet?.chains?.some?.(isSolanaChain)
          )
    ) || accounts[0]
  );
}

function serializeTransactionForWallet(tx) {
  if (tx instanceof VersionedTransaction) return tx.serialize();
  return tx.serialize({
    verifySignatures: false,
    requireAllSignatures: false,
  });
}

function deserializeSignedTransaction(serialized, original) {
  const bytes = toUint8Array(serialized);
  if (!bytes) throw new Error("Wallet returned an unreadable signed transaction");
  if (original instanceof VersionedTransaction) {
    return VersionedTransaction.deserialize(bytes);
  }
  return Transaction.from(bytes);
}

function extractSignedTransaction(output) {
  if (!output) return null;
  const first = Array.isArray(output) ? output[0] : output;
  return (
    toUint8Array(first?.signedTransaction) ||
    toUint8Array(first?.transaction) ||
    toUint8Array(first)
  );
}

function extractMessageSignature(output) {
  if (!output) return null;
  const first = Array.isArray(output) ? output[0] : output;
  return toUint8Array(first?.signature) || toUint8Array(first);
}

function supportsStandardWallet(wallet) {
  if (!wallet?.features) return false;
  if (!wallet.features["standard:connect"]?.connect) return false;
  if (!wallet.features["standard:disconnect"]?.disconnect) return false;
  if (!wallet.features["solana:signTransaction"]?.signTransaction) return false;
  const hasWalletChain =
    Array.isArray(wallet.chains) && wallet.chains.some(isSolanaChain);
  const hasAccountChain =
    Array.isArray(wallet.accounts) &&
    wallet.accounts.some((account) =>
      Array.isArray(account?.chains)
        ? account.chains.some(isSolanaChain)
        : Boolean(account?.address || account?.publicKey)
    );
  return hasWalletChain || hasAccountChain;
}

function registerStandardWallet(wallet) {
  if (!supportsStandardWallet(wallet)) return;
  const key = walletIdFromName(wallet.name) + "::" + String(wallet.version || "");
  standardWalletRegistry.set(key, wallet);
}

function handleWalletStandardDetail(detail) {
  if (!detail) return;
  if (typeof detail === "function") {
    try {
      detail(registerStandardWallet);
    } catch (_) {}
    return;
  }
  if (typeof detail.register === "function") {
    try {
      detail.register(registerStandardWallet);
    } catch (_) {}
    return;
  }
  if (Array.isArray(detail.wallets)) {
    detail.wallets.forEach(registerStandardWallet);
    return;
  }
  if (Array.isArray(detail)) {
    detail.forEach(registerStandardWallet);
    return;
  }
  registerStandardWallet(detail.wallet || detail);
}

function ensureWalletStandardDiscovery() {
  if (walletStandardBootstrapped || typeof window === "undefined") return;
  walletStandardBootstrapped = true;

  window.addEventListener(WALLET_STANDARD_REGISTER_EVENT, (event) => {
    handleWalletStandardDetail(event?.detail);
  });

  try {
    window.dispatchEvent(
      new CustomEvent(WALLET_STANDARD_APP_READY_EVENT, {
        detail: registerStandardWallet,
      })
    );
  } catch (_) {
    /* ignore */
  }
}

function createEmitter() {
  const listeners = new Map();

  const on = (event, handler) => {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(handler);
  };

  const off = (event, handler) => {
    listeners.get(event)?.delete(handler);
  };

  const emit = (event, value) => {
    listeners.get(event)?.forEach((handler) => {
      try {
        handler(value);
      } catch (_) {
        /* ignore listener failures */
      }
    });
  };

  return { on, off, emit };
}

function createWalletStandardAdapter(wallet) {
  const events = createEmitter();
  let account = pickStandardAccount(wallet);

  const adapter = {
    __neoDexAdapterId: walletIdFromName(wallet.name),
    __neoDexStandardWallet: wallet,
    __neoDexWalletStandard: true,
    get publicKey() {
      return getStandardAccountPublicKey(account);
    },
    async connect(options = undefined) {
      const connectFeature = wallet.features?.["standard:connect"];
      if (!connectFeature?.connect) {
        throw new Error((wallet.name || "Wallet") + " cannot connect");
      }
      const result = options?.onlyIfTrusted
        ? await connectFeature.connect({ silent: true })
        : await connectFeature.connect();
      account = pickStandardAccount(wallet, result?.accounts || wallet.accounts);
      const nextPk = getStandardAccountPublicKey(account);
      if (!nextPk) {
        throw new Error((wallet.name || "Wallet") + " did not expose a Solana account");
      }
      events.emit("accountChanged", nextPk);
      return nextPk;
    },
    async disconnect() {
      const disconnectFeature = wallet.features?.["standard:disconnect"];
      const hadAddress = getStandardAccountAddress(account);
      if (disconnectFeature?.disconnect) {
        await disconnectFeature.disconnect();
      }
      account = pickStandardAccount(wallet);
      if (hadAddress) {
        events.emit("accountChanged", null);
        events.emit("disconnect");
      }
    },
    async signTransaction(transaction) {
      const signFeature = wallet.features?.["solana:signTransaction"];
      if (!signFeature?.signTransaction) {
        throw new Error((wallet.name || "Wallet") + " cannot sign transactions");
      }
      const activeAccount = account || pickStandardAccount(wallet);
      if (!activeAccount) throw new Error("Wallet not connected");
      const signed = await signFeature.signTransaction({
        account: activeAccount,
        chain: pickSolanaChain(activeAccount, wallet),
        transaction: serializeTransactionForWallet(transaction),
      });
      const signedBytes = extractSignedTransaction(signed);
      if (!signedBytes) {
        throw new Error("Wallet did not return a signed transaction");
      }
      return deserializeSignedTransaction(signedBytes, transaction);
    },
    async signMessage(message) {
      const signFeature = wallet.features?.["solana:signMessage"];
      if (!signFeature?.signMessage) {
        throw new Error((wallet.name || "Wallet") + " cannot sign messages");
      }
      const activeAccount = account || pickStandardAccount(wallet);
      if (!activeAccount) throw new Error("Wallet not connected");
      const bytes =
        message instanceof Uint8Array ? message : new TextEncoder().encode(String(message || ""));
      const signed = await signFeature.signMessage({
        account: activeAccount,
        message: bytes,
      });
      const signature = extractMessageSignature(signed);
      if (!signature) {
        throw new Error("Wallet did not return a message signature");
      }
      return signature;
    },
    on(event, handler) {
      events.on(event, handler);
      return adapter;
    },
    off(event, handler) {
      events.off(event, handler);
      return adapter;
    },
    removeListener(event, handler) {
      events.off(event, handler);
      return adapter;
    },
  };

  try {
    wallet.features?.["standard:events"]?.on?.("change", (changes) => {
      const prevAddress = getStandardAccountAddress(account);
      const nextAccount = pickStandardAccount(
        wallet,
        changes?.accounts || wallet.accounts
      );
      const nextAddress = getStandardAccountAddress(nextAccount);
      account = nextAccount;

      if (prevAddress !== nextAddress) {
        events.emit("accountChanged", getStandardAccountPublicKey(nextAccount));
      }
      if (prevAddress && !nextAddress) {
        events.emit("disconnect");
      }
    });
  } catch (_) {
    /* ignore unsupported wallet-standard events */
  }

  return adapter;
}

function getWalletStandardAdapter(wallet) {
  let adapter = standardWalletAdapters.get(wallet);
  if (!adapter) {
    adapter = createWalletStandardAdapter(wallet);
    standardWalletAdapters.set(wallet, adapter);
  }
  return adapter;
}

export function listInstalledWallets() {
  ensureWalletStandardDiscovery();

  const installed = [];
  const seenIds = new Set();
  const seenNames = new Set();

  const pushAdapter = (id, name, adapter) => {
    if (!adapter) return;
    const normName = normalizeWalletName(name);
    if (seenIds.has(id) || seenNames.has(normName)) return;
    seenIds.add(id);
    seenNames.add(normName);
    installed.push({ id, name, adapter });
  };

  LEGACY_ADAPTERS.forEach((entry) => {
    pushAdapter(entry.id, entry.name, entry.get());
  });

  standardWalletRegistry.forEach((wallet) => {
    pushAdapter(walletIdFromName(wallet.name), wallet.name, getWalletStandardAdapter(wallet));
  });

  return installed;
}

function orderedAdapters() {
  const pref = readStoredWalletId();
  const installed = listInstalledWallets();
  const rest = installed.filter((entry) => entry.id !== pref);
  const first = installed.find((entry) => entry.id === pref);
  return pref && first ? [first, ...rest] : installed;
}

function detectAdapterId(adapter) {
  if (!adapter) return null;
  if (adapter.__neoDexAdapterId) return adapter.__neoDexAdapterId;
  if (adapter?.isSolflare) return "solflare";
  if (adapter?.isPhantom) return "phantom";
  if (adapter?.isBackpack || window.backpack?.solana === adapter) {
    return "backpack";
  }
  const found = LEGACY_ADAPTERS.find((entry) => entry.get() === adapter);
  return found?.id || null;
}

/** Wallet page chip (#home-address-chip) must mirror session state, not only async dashboard refresh. */
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
    emitWalletChanged();
    onChange?.();
  };
  const onAccountChanged = (pk) => {
    if (pk) {
      publicKey = pk instanceof PublicKey ? pk : new PublicKey(pk.toString());
      writeCachedWalletPk(publicKey.toBase58());
    } else {
      publicKey = null;
      provider = null;
      writeCachedWalletPk("");
    }
    syncHomePageWalletChip();
    emitWalletChanged();
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
  ensureWalletStandardDiscovery();
  try {
    if (sessionStorage.getItem(SS_SKIP_SILENT) === "1") return false;
  } catch (_) {
    /* private mode */
  }

  const pref = readStoredWalletId();
  if (pref) {
    const preferred = orderedAdapters().find((entry) => entry.id === pref);
    const p = preferred?.adapter || null;
    if (p) {
      try {
        await p.connect({ onlyIfTrusted: true });
        setConnectedWallet(p, pref, onChange);
        return true;
      } catch (_) {
        return false;
      }
    }
  }

  for (const entry of orderedAdapters()) {
    const p = entry.adapter;
    if (!p) continue;
    try {
      await p.connect({ onlyIfTrusted: true });
      setConnectedWallet(p, entry.id, onChange);
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
    adapterId || detectAdapterId(adapter) || readStoredWalletId() || "wallet";
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

/** Show the live connected address only; disconnected state stays explicit. */
export function walletConnectButtonLabel() {
  return publicKey ? fmtShortPk(publicKey) : "Connect wallet";
}

export function refreshWalletConnectButtonLabel(btn) {
  if (!btn) return;
  const live = walletConnectButtonLabel();
  const connected = Boolean(publicKey);
  btn.textContent = live;
  btn.dataset.walletConnected = connected ? "1" : "0";
  if (connected) {
    const full = publicKey.toBase58();
    btn.title = "Connected wallet " + full + ". Tap for wallet options.";
    btn.setAttribute(
      "aria-label",
      "Connected wallet " + full + ". Open wallet options."
    );
    return;
  }
  btn.removeAttribute("title");
  btn.setAttribute("aria-label", "Connect wallet");
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
    '<button type="button" class="neo-wp-close flex h-10 w-10 items-center justify-center rounded-full border-2 border-black text-xl font-bold leading-none hover:bg-black hover:text-white">x</button>' +
    "</div>" +
    '<p class="mb-4 text-sm font-medium text-outline">Pick an installed wallet.</p>' +
    '<div id="neo-wallet-picker-list" class="flex flex-col gap-2"></div>' +
    "</div></div>";
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
  ensureWalletStandardDiscovery();
  const root = ensurePicker();
  const list = root.querySelector("#neo-wallet-picker-list");
  list.innerHTML = "";

  const setPickerError = (message = "") => {
    let err = root.querySelector("[data-neo-wallet-error]");
    if (!message) {
      err?.remove();
      return;
    }
    if (!err) {
      err = document.createElement("p");
      err.dataset.neoWalletError = "1";
      err.className = "mt-2 text-[10px] font-bold uppercase text-error";
      list.insertAdjacentElement("afterend", err);
    }
    err.textContent = message;
  };

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
      '<p class="border-2 border-black bg-surface-container-low p-4 text-xs font-bold uppercase leading-relaxed">No Solana wallet detected. Install Phantom, Solflare, Backpack, or Jupiter Wallet.</p>';
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
        setPickerError("");
        btn.disabled = true;
        btn.classList.add("cursor-wait", "opacity-60");
        try {
          localStorage.setItem(LS_WALLET, id);
          await connectInteractive(adapter, onPicked, id);
          closeWalletPicker();
        } catch (e) {
          setPickerError((e && e.message) || "Connection failed");
        } finally {
          btn.disabled = false;
          btn.classList.remove("cursor-wait", "opacity-60");
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
 * the Disconnect / Change wallet menu; when disconnected, open the connect flow.
 */
export async function wireWalletConnectButton(onChange) {
  ensureWalletStandardDiscovery();
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

  await trySilentReconnect(onChange);
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
    queueMicrotask(() => {
      openWalletPicker(() => {
        refreshWalletConnectButtonLabel(btn);
        onChange?.();
      });
    });
  });
}
