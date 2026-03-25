/** Jupiter quote + swap build (v6 then Metis). Proxy in dev / when VITE_JUPITER_SAME_ORIGIN=true. */
function useSameOriginJupiterProxy() {
  if (import.meta.env.VITE_JUPITER_SAME_ORIGIN === "true") return true;
  if (import.meta.env.VITE_JUPITER_SAME_ORIGIN === "false") return false;
  return Boolean(import.meta.env.DEV);
}

/** Metis endpoints need x-api-key when used. */
function jupiterEndpointPairs(queryString, hasApiKey) {
  const lite = useSameOriginJupiterProxy()
    ? {
        kind: "metis",
        quoteUrl:
          "/__jupiter_api/swap/v1/quote?" +
          queryString +
          "&restrictIntermediateTokens=true&instructionVersion=V2",
        swapUrl: "/__jupiter_api/swap/v1/swap",
      }
    : {
        kind: "metis",
        quoteUrl:
          "https://lite-api.jup.ag/swap/v1/quote?" +
          queryString +
          "&restrictIntermediateTokens=true&instructionVersion=V2",
        swapUrl: "https://lite-api.jup.ag/swap/v1/swap",
      };

  const metisQs =
    queryString +
    (queryString.length ? "&" : "") +
    "restrictIntermediateTokens=true&instructionVersion=V2";
  const metis = useSameOriginJupiterProxy()
    ? {
        kind: "metis",
        quoteUrl: "/__jupiter_api/swap/v1/quote?" + metisQs,
        swapUrl: "/__jupiter_api/swap/v1/swap",
      }
    : {
        kind: "metis",
        quoteUrl: "https://api.jup.ag/swap/v1/quote?" + metisQs,
        swapUrl: "https://api.jup.ag/swap/v1/swap",
      };

  if (!hasApiKey) return [lite];
  return [lite, metis];
}

function formatJupiterErrorBody(status, text) {
  const raw = String(text || "").trim();
  try {
    const j = JSON.parse(raw);
    const code = j.code ?? j.CODE;
    const msg = j.message ?? j.MESSAGE ?? j.error;
    if (status === 401 || code === 401) {
      return (
        "Jupiter API key required (401). Create a key at https://portal.jup.ag/ then set " +
        "VITE_JUPITER_API_KEY in .env and restart the dev server."
      );
    }
    if (msg) return "Jupiter: " + msg;
  } catch {
    /* not JSON */
  }
  if (status === 401) {
    return (
      "Jupiter API key required (401). Add VITE_JUPITER_API_KEY from https://portal.jup.ag/"
    );
  }
  return raw || "HTTP " + status;
}

export async function fetchSwapQuote(queryString, signal) {
  const headers = {};
  const apiKey = import.meta.env.VITE_JUPITER_API_KEY;
  if (apiKey) headers["x-api-key"] = apiKey;

  const endpoints = jupiterEndpointPairs(queryString, Boolean(apiKey));

  let lastErr = null;
  for (const ep of endpoints) {
    try {
      const res = await fetch(ep.quoteUrl, {
        method: "GET",
        headers,
        signal,
      });
      if (!res.ok) {
        const t = await res.text().catch(() => "");
        lastErr = new Error(formatJupiterErrorBody(res.status, t));
        continue;
      }
      const json = await res.json();
      if (json?.outAmount != null && json?.inAmount != null) {
        return { quote: json, swapUrl: ep.swapUrl, kind: ep.kind };
      }
      lastErr = new Error("Unexpected quote shape from " + ep.kind);
    } catch (e) {
      if (e?.name === "AbortError") throw e;
      lastErr = e;
    }
  }

  const isNetwork =
    !lastErr ||
    lastErr?.name === "TypeError" ||
    /failed to fetch|network|load failed|aborted/i.test(String(lastErr?.message || ""));
  const hint = isNetwork
    ? useSameOriginJupiterProxy()
      ? " Network error even via dev proxy—check firewall/VPN. If v6 is blocked, add VITE_JUPITER_API_KEY for Metis fallback."
      : " Could not reach Jupiter (CORS/network). Run `npm run dev` (same-origin proxy), host `/__jupiter_*` rewrites, or set VITE_JUPITER_API_KEY."
    : !apiKey
      ? " With no API key, only the legacy v6 quote route is used. If that fails, get a key at https://portal.jup.ag/ and set VITE_JUPITER_API_KEY."
      : "";
  throw new Error(
    (lastErr && lastErr.message) || "All Jupiter quote endpoints failed." + hint
  );
}

export function buildSwapRequestBody(quote, userPublicKeyBase58, kind) {
  const body = {
    quoteResponse: quote,
    userPublicKey: userPublicKeyBase58,
    wrapAndUnwrapSol: true,
    dynamicComputeUnitLimit: true,
  };
  if (kind === "metis") {
    body.prioritizationFeeLamports = {
      priorityLevelWithMaxLamports: {
        priorityLevel: "high",
        maxLamports: 800_000,
        global: false,
      },
    };
  } else {
    body.prioritizationFeeLamports = "auto";
  }
  return body;
}
