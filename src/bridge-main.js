import { bindDecimalInput } from "./lib/input-decimal.js";
import { Buffer } from "buffer";
import {
  AddressLookupTableAccount,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  getPublicKey,
  getProvider,
  wireWalletConnectButton,
  trySilentReconnect,
  openWalletPicker,
  refreshWalletConnectButtonLabel,
} from "./lib/wallet-session.js";
import { withRpcRetry, waitForSignatureConfirmation } from "./lib/solana-rpc.js";
import { recordSiteBridge } from "./lib/site-activity.js";
import { openPopup, closePopup } from "./lib/popup-motion.js";

const RELAY_CHAINS_URL = "https://api.relay.link/chains";
const RELAY_QUOTE_URL = "https://api.relay.link/quote/v2";
const RELAY_API_BASE = "https://api.relay.link";
const SOLANA_CHAIN_ID = 792703809;
const SOLANA_NATIVE_MINT = "11111111111111111111111111111111";
const TOP_CHAIN_NAMES = ["Abstract", "Base", "Ethereum", "Arbitrum", "Optimism"];

let bridgeChains = [];
let selectedDestinationChainId = null;
let bridgeToastTimer = null;

function setBridgeStatus(message, isError = false) {
  const statusEl = document.getElementById("bridge-status");
  if (!statusEl) return;
  statusEl.textContent = message || "";
  statusEl.className =
    "pt-1 text-[10px] font-bold uppercase " +
    (isError ? "text-error" : "text-on-surface-variant");
}

function clearBridgeToastTimer() {
  if (bridgeToastTimer) {
    clearTimeout(bridgeToastTimer);
    bridgeToastTimer = null;
  }
}

function hideBridgeToast() {
  clearBridgeToastTimer();
  const host = document.getElementById("bridge-toast-host");
  if (host) host.innerHTML = "";
}

function showBridgeToast(message, variant = "info", opts = {}) {
  const host = document.getElementById("bridge-toast-host");
  if (!host) return;
  hideBridgeToast();
  const wrap = document.createElement("div");
  wrap.className =
    "pointer-events-auto border-4 border-black px-5 py-4 text-sm font-extrabold uppercase leading-snug tracking-tight shadow-[6px_6px_0_0_#000] " +
    (variant === "success"
      ? "bg-primary-container text-black"
      : variant === "error"
        ? "bg-error-container text-white"
        : "bg-white text-black");
  if (opts.linkHref && opts.linkLabel) {
    const p = document.createElement("p");
    p.textContent = message;
    const a = document.createElement("a");
    a.href = opts.linkHref;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.className =
      "mt-2 block text-xs font-extrabold uppercase underline decoration-2 underline-offset-4";
    a.textContent = opts.linkLabel;
    wrap.appendChild(p);
    wrap.appendChild(a);
  } else {
    wrap.textContent = message;
  }
  host.appendChild(wrap);
  if (opts.noAutoDismiss) return;
  const ms = opts.durationMs ?? (variant === "success" ? 6500 : 4500);
  bridgeToastTimer = setTimeout(() => {
    host.innerHTML = "";
    bridgeToastTimer = null;
  }, ms);
}

function selectedDestinationChain() {
  if (!Number.isFinite(selectedDestinationChainId)) return null;
  return (
    bridgeChains.find((c) => Number(c.id) === Number(selectedDestinationChainId)) ||
    null
  );
}

function renderSelectedDestinationLabel() {
  const label = document.getElementById("bridge-destination-chain-label");
  if (!label) return;
  const chain = selectedDestinationChain();
  label.textContent = chain?.displayName || "Select";
  const icon = document.getElementById("bridge-destination-chain-icon");
  const fallback = document.getElementById(
    "bridge-destination-chain-icon-fallback"
  );
  if (!icon || !fallback) return;
  const src = String(chain?.iconUrl || chain?.logoUrl || "").trim();
  if (!src) {
    icon.classList.add("hidden");
    fallback.classList.remove("hidden");
    return;
  }
  icon.src = src;
  icon.onerror = () => {
    icon.classList.add("hidden");
    fallback.classList.remove("hidden");
  };
  icon.classList.remove("hidden");
  fallback.classList.add("hidden");
}

function updateBridgeSubmitState() {
  const submit = document.getElementById("bridge-submit");
  if (!submit) return;
  if (!getPublicKey()) {
    submit.textContent = "Connect wallet";
    submit.disabled = false;
    return;
  }
  submit.textContent = "Bridge out";
  submit.disabled = false;
}

function syncBridgeWalletUi() {
  const btn = document.getElementById("wallet-connect");
  refreshWalletConnectButtonLabel(btn);
  updateBridgeSubmitState();
}

async function ensureWalletForBridge() {
  if (getPublicKey() && getProvider()) return true;
  const silent = await trySilentReconnect(syncBridgeWalletUi);
  if (silent) return true;
  setBridgeStatus("Choose a wallet to continue", true);
  openWalletPicker(syncBridgeWalletUi);
  return false;
}

async function loadRelayChains() {
  try {
    const res = await fetch(RELAY_CHAINS_URL, { method: "GET" });
    if (!res.ok) throw new Error("Failed to fetch Relay chains");
    const data = await res.json();
    const chains = Array.isArray(data?.chains) ? data.chains : [];
    bridgeChains = chains
      .filter((c) => c && c.depositEnabled && !c.disabled)
      .filter((c) => Number(c.id) !== SOLANA_CHAIN_ID)
      .sort((a, b) =>
        String(a.displayName || a.name || "").localeCompare(
          String(b.displayName || b.name || ""),
          undefined,
          { sensitivity: "base" }
        )
      );

    if (!bridgeChains.length) {
      setBridgeStatus("Relay did not return destination chains", true);
      return;
    }
    const top = topPreviewChains();
    selectedDestinationChainId = Number(
      top[0]?.id ?? bridgeChains[0]?.id ?? Number.NaN
    );

    renderSelectedDestinationLabel();
  } catch (err) {
    setBridgeStatus((err && err.message) || "Could not load chains", true);
  }
}

function topPreviewChains() {
  const byLowerName = new Map();
  for (const chain of bridgeChains) {
    byLowerName.set(
      String(chain.displayName || chain.name || "").toLowerCase(),
      chain
    );
  }
  const selected = [];
  const used = new Set();
  for (const name of TOP_CHAIN_NAMES) {
    const c = byLowerName.get(name.toLowerCase());
    if (c && !used.has(c.id)) {
      used.add(c.id);
      selected.push(c);
    }
  }
  for (const c of bridgeChains) {
    if (selected.length >= 5) break;
    if (!used.has(c.id)) {
      used.add(c.id);
      selected.push(c);
    }
  }
  return selected.slice(0, 5);
}

function filteredChains(query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return topPreviewChains();
  return bridgeChains
    .filter((c) => {
      const hay = `${c.displayName || ""} ${c.name || ""}`.toLowerCase();
      return hay.includes(q);
    })
    .slice(0, 50);
}

function renderChainList(chains, close) {
  const list = document.getElementById("bridge-chain-list");
  if (!list) return;
  list.innerHTML = "";
  if (!chains.length) {
    const empty = document.createElement("p");
    empty.className = "px-3 py-4 text-xs font-bold uppercase text-outline";
    empty.textContent = "No chains found";
    list.appendChild(empty);
    return;
  }
  chains.forEach((chain, idx) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className =
      "flex w-full items-center gap-3 border-b-2 border-black px-3 py-3 text-left hover:bg-primary-container " +
      (idx % 2 ? "bg-surface-container-low" : "bg-surface-container-lowest");
    const logo = chain.iconUrl
      ? `<img src="${chain.iconUrl}" alt="" class="h-7 w-7 rounded-full border border-black bg-white object-cover" loading="lazy" referrerpolicy="no-referrer" />`
      : '<span class="material-symbols-outlined text-lg">hub</span>';
    const name = chain.displayName || chain.name || String(chain.id);
    btn.innerHTML =
      logo +
      '<span class="text-xs font-extrabold uppercase tracking-tight">' +
      name +
      "</span>";
    btn.addEventListener("click", () => {
      selectedDestinationChainId = Number(chain.id);
      renderSelectedDestinationLabel();
      close();
    });
    list.appendChild(btn);
  });
}

function initChainModal() {
  const modal = document.getElementById("bridge-chain-modal");
  const search = document.getElementById("bridge-chain-search");
  const help = document.getElementById("bridge-chain-help");
  const backdrop = modal?.querySelector("[data-popup-backdrop]");
  const panel = modal?.querySelector("[data-popup-panel]");
  if (!modal || !search || !help) return;

  function close() {
    closePopup(modal, { panel, backdrop });
  }

  function refresh() {
    const q = search.value || "";
    const rows = filteredChains(q);
    help.textContent = q.trim() ? "Search results" : "Top chains";
    renderChainList(rows, close);
  }

  function open() {
    openPopup(modal, { panel, backdrop });
    search.value = "";
    refresh();
  }

  document.getElementById("bridge-destination-chain-btn")?.addEventListener(
    "click",
    open
  );
  modal
    .querySelectorAll("[data-bridge-chain-close]")
    .forEach((el) => el.addEventListener("click", close));
  modal
    .querySelector("[data-bridge-chain-backdrop]")
    ?.addEventListener("click", close);
  search.addEventListener("input", refresh);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !modal.classList.contains("hidden")) close();
  });
}

function toAtomicSol(amountUi) {
  const n = Number(amountUi);
  if (!Number.isFinite(n) || n <= 0) return null;
  return BigInt(Math.floor(n * 1e9)).toString();
}

function hexToBytes(input) {
  const raw = String(input || "").trim();
  const hex = raw.startsWith("0x") ? raw.slice(2) : raw;
  if (!hex || hex.length % 2 !== 0) return new Uint8Array();
  return Uint8Array.from(Buffer.from(hex, "hex"));
}

async function fetchLookupTables(conn, addresses) {
  if (!Array.isArray(addresses) || !addresses.length) return [];
  const pks = addresses
    .map((a) => {
      try {
        return new PublicKey(String(a));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  if (!pks.length) return [];
  const infos = await conn.getMultipleAccountsInfo(pks, "confirmed");
  const tables = [];
  for (let i = 0; i < infos.length; i++) {
    const info = infos[i];
    if (!info) continue;
    try {
      tables.push(new AddressLookupTableAccount({ key: pks[i], state: AddressLookupTableAccount.deserialize(info.data) }));
    } catch {
      /* ignore malformed ALTs */
    }
  }
  return tables;
}

function normalizeTxInstructions(stepItem) {
  const payload = stepItem?.data || {};
  const list = Array.isArray(payload.instructions) ? payload.instructions : [];
  return list
    .map((ix) => {
      try {
        return new TransactionInstruction({
          programId: new PublicKey(ix.programId),
          keys: (ix.keys || []).map((k) => ({
            pubkey: new PublicKey(k.pubkey),
            isSigner: Boolean(k.isSigner),
            isWritable: Boolean(k.isWritable),
          })),
          data: hexToBytes(ix.data),
        });
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

async function pollRelayCheck(check, timeoutMs = 120000) {
  if (!check?.endpoint) return true;
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const url = check.endpoint.startsWith("http")
      ? check.endpoint
      : `${RELAY_API_BASE}${check.endpoint}`;
    try {
      const res = await fetch(url, { method: check.method || "GET" });
      if (!res.ok) {
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      const data = await res.json();
      const status = String(data?.status || "").toLowerCase();
      if (data?.success === true) return true;
      if (status === "success" || status === "completed") return true;
      if (status === "failure" || status === "failed" || status === "refunded") {
        throw new Error("Bridge failed on Relay status check");
      }
    } catch (err) {
      const msg = String(err?.message || "");
      if (msg.toLowerCase().includes("failed")) throw err;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error("Bridge status confirmation timed out");
}

async function runRelayBridge({ destinationChain, amount, recipient }) {
  const pk = getPublicKey();
  const provider = getProvider();
  if (!pk || !provider) throw new Error("Wallet not connected");
  const atomic = toAtomicSol(amount);
  if (!atomic) throw new Error("Invalid amount");

  const quoteBody = {
    user: pk.toBase58(),
    originChainId: SOLANA_CHAIN_ID,
    originCurrency: SOLANA_NATIVE_MINT,
    destinationChainId: Number(destinationChain.id),
    destinationCurrency: destinationChain?.currency?.address || "0x0000000000000000000000000000000000000000",
    recipient,
    tradeType: "EXACT_INPUT",
    amount: atomic,
  };

  const quoteRes = await fetch(RELAY_QUOTE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(quoteBody),
  });
  if (!quoteRes.ok) {
    const t = await quoteRes.text();
    throw new Error(t || "Failed to fetch Relay quote");
  }
  const quote = await quoteRes.json();
  const steps = Array.isArray(quote?.steps) ? quote.steps : [];
  if (!steps.length) throw new Error("No executable Relay steps returned");

  let firstSig = "";
  for (const step of steps) {
    showBridgeToast(step?.action || "Confirm transaction in wallet", "info", {
      noAutoDismiss: true,
    });
    if (step.kind !== "transaction") {
      throw new Error("Unsupported Relay step type: " + step.kind);
    }
    const items = Array.isArray(step.items) ? step.items : [];
    for (const item of items) {
      const sig = await withRpcRetry(async (conn) => {
        const instructions = normalizeTxInstructions(item);
        if (!instructions.length) throw new Error("Relay transaction instructions missing");
        const lookupTables = await fetchLookupTables(
          conn,
          item?.data?.addressLookupTableAddresses || []
        );
        const { blockhash } = await conn.getLatestBlockhash("confirmed");
        const message = new TransactionMessage({
          payerKey: pk,
          recentBlockhash: blockhash,
          instructions,
        }).compileToV0Message(lookupTables);
        const tx = new VersionedTransaction(message);
        const signed = await provider.signTransaction(tx);
        return conn.sendRawTransaction(signed.serialize(), {
          skipPreflight: false,
          maxRetries: 3,
        });
      });
      if (!firstSig) firstSig = sig;
      showBridgeToast("Confirming transaction…", "info", { noAutoDismiss: true });
      await waitForSignatureConfirmation(sig, { timeoutMs: 90000 });
      showBridgeToast("Waiting for Relay fill…", "info", { noAutoDismiss: true });
      await pollRelayCheck(item?.check);
    }
  }
  return { signature: firstSig, quote };
}

async function handleBridgeSubmit() {
  setBridgeStatus("");
  const ok = await ensureWalletForBridge();
  if (!ok) return;

  const amountInput = document.getElementById("bridge-amount");
  const recipientInput = document.getElementById("bridge-to-address");
  const destinationChain = selectedDestinationChain();

  const amount = String(amountInput?.value || "").trim();
  const amountNumber = Number(amount);
  if (!amount || !Number.isFinite(amountNumber) || amountNumber <= 0) {
    setBridgeStatus("Enter a valid SOL amount", true);
    amountInput?.focus();
    return;
  }

  const recipient = String(recipientInput?.value || "").trim();
  if (!recipient) {
    setBridgeStatus("Enter recipient address for destination chain", true);
    recipientInput?.focus();
    return;
  }

  if (!destinationChain) {
    setBridgeStatus("Choose a destination chain", true);
    return;
  }

  const submit = document.getElementById("bridge-submit");
  if (submit) submit.disabled = true;
  try {
    showBridgeToast("Requesting Relay quote…", "info", { noAutoDismiss: true });
    const out = await runRelayBridge({ destinationChain, amount, recipient });
    setBridgeStatus("", false);
    hideBridgeToast();
    const sig = out?.signature || "";
    if (sig) {
      recordSiteBridge({
        wallet: getPublicKey()?.toBase58(),
        signature: sig,
        amountHuman: amount,
        symbol: "SOL",
        recipient,
        originChainId: SOLANA_CHAIN_ID,
        destinationChainId: Number(destinationChain.id),
        destinationChainName:
          destinationChain.displayName || destinationChain.name || "",
      });
      showBridgeToast("Bridge submitted successfully", "success", {
        linkHref: "https://solscan.io/tx/" + sig,
        linkLabel: "View on Solscan",
      });
    } else {
      showBridgeToast("Bridge submitted successfully", "success");
    }
  } catch (err) {
    hideBridgeToast();
    showBridgeToast((err && err.message) || "Bridge failed", "error", {
      durationMs: 7000,
    });
    setBridgeStatus((err && err.message) || "Bridge failed", true);
  } finally {
    if (submit) submit.disabled = false;
  }
}

async function init() {
  const amount = document.getElementById("bridge-amount");
  if (amount) bindDecimalInput(amount, { maxDecimals: 9 });

  initChainModal();

  document.querySelectorAll("[data-bridge-preset]").forEach((btn) => {
    btn.addEventListener("click", function () {
      if (!amount) return;
      amount.value = btn.getAttribute("data-bridge-preset") || "";
      amount.focus();
    });
  });

  document.getElementById("bridge-submit")?.addEventListener("click", () => {
    void handleBridgeSubmit();
  });

  await wireWalletConnectButton(syncBridgeWalletUi);
  await loadRelayChains();
  syncBridgeWalletUi();
}

init().catch((err) => {
  console.error("bridge page init failed", err);
  setBridgeStatus("Could not initialize bridge page", true);
});
