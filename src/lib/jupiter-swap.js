/**
 * Jupiter swap quote + transaction build. Tries v6 then Metis v1.
 *
 * jup.ag/swap uses the same public Jupiter Swap API (see https://docs.jup.ag/ ),
 * not a different engine. Their UI succeeds more often in browsers because calls
 * are same-origin or keyed; we can mirror that with Vite proxy (dev) or your
 * own reverse proxy (prod) via VITE_JUPITER_SAME_ORIGIN=true.
 */
function useSameOriginJupiterProxy() {
  if (import.meta.env.VITE_JUPITER_SAME_ORIGIN === "true") return true;
  if (import.meta.env.VITE_JUPITER_SAME_ORIGIN === "false") return false;
  return Boolean(import.meta.env.DEV);
}

/**
 * Metis (`api.jup.ag/swap/v1/*`) requires `x-api-key` — see https://dev.jup.ag/docs/swap-api/get-quote
 * Calling it without a key always yields 401 and confuses users when v6 fails first.
 */
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
    // #region agent log
    fetch('http://127.0.0.1:7266/ingest/8f27976a-4ceb-42a9-90ca-4f04f3c39944',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'00c163'},body:JSON.stringify({sessionId:'00c163',runId:'pre-fix',hypothesisId:'H4',location:'jupiter-swap.js:fetchSwapQuote:attempt',message:'jupiter quote attempt',data:{kind:ep.kind,quoteUrl:ep.quoteUrl.slice(0,120)},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
    try {
      const res = await fetch(ep.quoteUrl, {
        method: "GET",
        headers,
        signal,
      });
      if (!res.ok) {
        const t = await res.text().catch(() => "");
        // #region agent log
        fetch('http://127.0.0.1:7266/ingest/8f27976a-4ceb-42a9-90ca-4f04f3c39944',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'00c163'},body:JSON.stringify({sessionId:'00c163',runId:'pre-fix',hypothesisId:'H4',location:'jupiter-swap.js:fetchSwapQuote:http-fail',message:'jupiter quote http failure',data:{kind:ep.kind,status:res.status,body:String(t).slice(0,160)},timestamp:Date.now()})}).catch(()=>{});
        // #endregion
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
