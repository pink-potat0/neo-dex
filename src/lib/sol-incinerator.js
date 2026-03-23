const SOL_INCINERATOR_API_ROOT = "https://v2.api.sol-incinerator.com";

function apiKey() {
  return String(import.meta.env.VITE_SOL_INCINERATOR_API_KEY || "").trim();
}

function requireApiKey() {
  const key = apiKey();
  if (!key) {
    throw new Error("Missing VITE_SOL_INCINERATOR_API_KEY for Sol Incinerator API.");
  }
  return key;
}

async function apiPost(path, body) {
  const res = await fetch(SOL_INCINERATOR_API_ROOT + path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": requireApiKey(),
    },
    body: JSON.stringify(body || {}),
  });

  const text = await res.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { message: text || "" };
  }

  if (!res.ok) {
    throw new Error(
      payload?.message ||
      payload?.error ||
      `Sol Incinerator API request failed (${res.status}).`
    );
  }
  return payload;
}

export function hasSolIncineratorApiKey() {
  return Boolean(apiKey());
}

export function summarizeCloseAll(userPublicKey) {
  return apiPost("/batch/close-all/summary", { userPublicKey });
}

export function previewCloseAllPage(userPublicKey, offset = 0, limit = 500) {
  return apiPost("/batch/close-all/preview", { userPublicKey, offset, limit });
}

export function buildCloseAllPage(userPublicKey, offset = 0, limit = 500) {
  return apiPost("/batch/close-all", { userPublicKey, offset, limit });
}

export function buildBurnTransaction(userPublicKey, assetId, extra = {}) {
  return apiPost("/burn", {
    userPublicKey,
    assetId,
    ...extra,
  });
}

export function relaySignedTransaction(signedTransaction, extra = {}) {
  return apiPost("/transactions/send", {
    signedTransaction,
    ...extra,
  });
}

export function relaySignedTransactionsBatch(signedTransactions, extra = {}) {
  return apiPost("/transactions/send-batch", {
    signedTransactions,
    ...extra,
  });
}
