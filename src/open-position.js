import { escapeHtml } from "./telegram.js";
import { formatTimestampWIB } from "./position-notify.js";

const CHAINS = {
  robinhood: "robinhood",
  hood: "robinhood",
  rh: "robinhood",
  base: "base",
  bsc: "bsc",
  bnb: "bsc",
  ethereum: "ethereum",
  eth: "ethereum",
  auto: "auto",
};

const SIDES = new Set(["single", "double", "token"]);

const SIDE_RANGES = {
  single: { min: -80, max: -1 },
  double: { min: -60, max: 150 },
  token: { min: 1, max: 150 },
};

/** Same quote list as the Pro desk Open LP preset. */
const QUOTES = {
  usdg: "usdg",
  usdt: "usdt",
  usdc: "usdc",
  eth: "eth",
  weth: "eth",
  bnb: "bnb",
  wbnb: "bnb",
  both: "both",
};

const DEFAULT_QUOTE_BY_CHAIN = {
  robinhood: "usdg",
  base: "usdc",
  bsc: "usdt",
  ethereum: "eth",
  auto: "usdg",
};

const STABLE_QUOTE = /usdg|usdt|usdc/i;

function num(v) {
  if (v == null || v === "") return null;
  const n = Number(String(v).trim().replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function isEvmToken(raw) {
  return /^0x[a-fA-F0-9]{40}$/.test(String(raw || "").trim());
}

function parseKv(arg) {
  const m = String(arg || "").match(/^([a-z_]+)=(.+)$/i);
  if (!m) return null;
  return { key: m[1].toLowerCase(), value: m[2] };
}

function applyOption(out, key, value) {
  if (key === "sl" || key === "stop_loss" || key === "stoploss") {
    out.stop_loss = num(value);
    return;
  }
  if (key === "tp" || key === "take_profit" || key === "takeprofit") {
    out.take_profit = num(value);
    return;
  }
  if (key === "side") {
    const side = String(value || "").toLowerCase();
    if (SIDES.has(side)) out.side = side;
    return;
  }
  if (key === "min" || key === "min_pct" || key === "range_min") {
    out.range_min_pct = num(value);
    return;
  }
  if (key === "max" || key === "max_pct" || key === "range_max") {
    out.range_max_pct = num(value);
    return;
  }
  if (key === "pool") {
    out.pool = String(value || "").trim();
    return;
  }
  if (key === "quote") {
    out.quote = String(value || "").trim().toLowerCase();
    return;
  }
  if (key === "chain") {
    const mapped = CHAINS[String(value || "").toLowerCase()];
    if (mapped) out.chain = mapped;
  }
}

export function parseOpenCommand(args) {
  const rest = (Array.isArray(args) ? args : []).map((a) => String(a).trim()).filter(Boolean);
  if (rest.length < 2) {
    return { error: "usage" };
  }

  const token = rest.shift();
  if (!isEvmToken(token)) {
    return { error: "token" };
  }

  const amount = num(rest.shift());
  if (amount == null || amount <= 0) {
    return { error: "amount" };
  }

  const out = {
    token: token.toLowerCase(),
    amount,
    chain: "auto",
    side: "single",
    stop_loss: null,
    take_profit: null,
    range_min_pct: null,
    range_max_pct: null,
    pool: "",
    quote: "",
  };

  const positionalNums = [];
  for (const arg of rest) {
    const kv = parseKv(arg);
    if (kv) {
      applyOption(out, kv.key, kv.value);
      continue;
    }
    const lower = arg.toLowerCase();
    const mapped = CHAINS[lower];
    const quoteWord = QUOTES[lower];
    // Stables are never chain names. eth/bnb stay chain unless chain is already set.
    if (quoteWord && (!mapped || (out.chain && out.chain !== "auto"))) {
      out.quote = quoteWord;
      continue;
    }
    if (mapped) {
      out.chain = mapped;
      continue;
    }
    if (SIDES.has(lower)) {
      out.side = lower;
      continue;
    }
    const n = num(arg);
    if (n != null) {
      positionalNums.push(n);
      continue;
    }
    return { error: "unknown", detail: arg };
  }

  if (positionalNums[0] != null && out.stop_loss == null) out.stop_loss = positionalNums[0];
  if (positionalNums[1] != null && out.take_profit == null) out.take_profit = positionalNums[1];
  if (!out.quote) out.quote = DEFAULT_QUOTE_BY_CHAIN[out.chain] || "usdg";

  const band = SIDE_RANGES[out.side] || SIDE_RANGES.single;
  if (out.range_min_pct == null) out.range_min_pct = band.min;
  if (out.range_max_pct == null) out.range_max_pct = band.max;

  return out;
}

export function pickOpenPool(lookup, { pool, chain, quote } = {}) {
  const venue = String(lookup?.type || lookup?.network || "uniswap").toLowerCase();
  if (venue && venue !== "uniswap" && venue !== "evm") return null;

  const pools = Array.isArray(lookup?.pools) ? lookup.pools : [];
  let list = pools.filter((p) => p?.pool && p.openable !== false);

  if (pool) {
    const want = String(pool).toLowerCase();
    const hit = list.find((p) => String(p.pool).toLowerCase() === want);
    if (hit) return hit;
  }

  list = list.filter((p) => {
    const v = String(p.venue || "uniswap").toLowerCase();
    return v === "uniswap" || v === "";
  });

  if (chain && chain !== "auto") {
    const filtered = list.filter((p) => String(p.chain || "").toLowerCase() === chain);
    if (filtered.length) list = filtered;
  }

  if (quote) {
    const q = String(quote).toLowerCase();
    const filtered = list.filter((p) => String(p.quote_symbol || "").toLowerCase() === q);
    if (filtered.length) list = filtered;
  }

  return list[0] || null;
}

export function buildDeployPayload(lookup, pool, parsed) {
  const token = lookup?.token || {};
  const quoteSymbol = pool.quote_symbol || token.quote_symbol || "";
  const amount = parsed.amount;
  const stable = STABLE_QUOTE.test(quoteSymbol);

  return {
    venue: "uniswap",
    pool: pool.pool,
    mint: token.mint || token.token || parsed.token,
    token_address: pool.token_address || token.token || token.mint || parsed.token,
    pair: pool.name || token.pair || null,
    symbol: token.symbol || (pool.name || "").split("/")[0] || null,
    chain: pool.chain || token.chain || parsed.chain || "auto",
    fee: pool.fee,
    version: pool.version,
    dex: pool.dex,
    liquidity_usd: pool.liquidity_usd || pool.tvl,
    volume_24h: pool.volume_24h,
    amount,
    amount_eth: amount,
    amount_usdg: stable ? amount : null,
    side: parsed.side || "single",
    range_min_pct: parsed.range_min_pct,
    range_max_pct: parsed.range_max_pct,
    mcap: pool.mcap ?? token.mcap ?? null,
    stop_loss: parsed.stop_loss,
    take_profit: parsed.take_profit,
  };
}

export function lookupBody(parsed) {
  return {
    token: parsed.token,
    chain: parsed.chain || "auto",
    amount: parsed.amount,
    side: parsed.side || "single",
    quote: parsed.quote || undefined,
    min_pct: parsed.range_min_pct,
    max_pct: parsed.range_max_pct,
    stop_loss: parsed.stop_loss,
    take_profit: parsed.take_profit,
  };
}

export function formatOpenUsage() {
  return [
    "⚠️ /open butuh token EVM dan amount.",
    "Pakai <code>/open &lt;0x token&gt; &lt;amount&gt; [chain] [quote] [side] [sl=] [tp=]</code>",
    "Contoh: <code>/open 0xabc… 0.5 robinhood quote=usdg sl=-50 tp=20</code>",
    "Quote default: robinhood=USDG, base=USDC, bsc=USDT. Amount dalam token quote itu.",
    "Override: <code>quote=eth</code> / <code>quote=bnb</code> / <code>usdt</code>. Side: single / double / token.",
  ].join("\n");
}

function amountLabel(payload, pool) {
  const quote = pool?.quote_symbol || "";
  const n = payload?.amount;
  if (n == null) return "";
  return quote ? `${n} ${quote}` : String(n);
}

export function formatOpenMessage({ lookup, pool, payload, result, error, dry } = {}) {
  const pair = pool?.name || lookup?.token?.pair || lookup?.token?.symbol || payload?.pair || "Unknown";
  const chain = payload?.chain || pool?.chain || lookup?.token?.chain || "";
  const chainLabel = chain ? chain.charAt(0).toUpperCase() + chain.slice(1) : "";
  const title = chainLabel ? `${escapeHtml(pair)} · ${escapeHtml(chainLabel)}` : escapeHtml(pair);
  const timestamp = formatTimestampWIB();
  const amt = amountLabel(payload, pool);
  const quote = pool?.quote_symbol || lookup?.preset?.quote_symbol || "";
  const range = payload?.range_min_pct != null && payload?.range_max_pct != null
    ? `${payload.range_min_pct}% … ${payload.range_max_pct}%`
    : "—";
  const sl = payload?.stop_loss != null ? `${payload.stop_loss}%` : "—";
  const tp = payload?.take_profit != null ? `${payload.take_profit}%` : "—";
  const poolAddr = pool?.pool ? `<code>${escapeHtml(pool.pool)}</code>` : "—";
  const grade = pool?.grade ? ` · ${escapeHtml(pool.grade)}` : "";
  const quoteLine = quote ? `Quote: ${escapeHtml(quote)}` : null;

  if (dry) {
    return [
      `🧪 <b>[DRY] Would Open</b>`,
      `<b>${title}</b>`,
      "",
      `Pool: ${poolAddr}${grade}`,
      quoteLine,
      amt ? `Amount: ${escapeHtml(amt)}` : null,
      `Range: ${escapeHtml(range)}`,
      `SL / TP: ${escapeHtml(sl)} / ${escapeHtml(tp)}`,
      "",
      "LIVE_OPEN=0 — set LIVE_OPEN=1 di .env untuk mint.",
      `🕐 ${timestamp}`,
    ].filter((line) => line != null).join("\n");
  }

  if (error) {
    return [
      `⚠️ <b>Open Failed</b>`,
      `<b>${title}</b>`,
      "",
      `Reason: ${escapeHtml(error)}`,
      `🕐 ${timestamp}`,
    ].join("\n");
  }

  const tx = result?.tx || result?.txs?.[0] || result?.swap_tx || "";
  const posId = result?.position || result?.tokenId || "";
  const lines = [
    `🟢 <b>Position Opened</b>`,
    `<b>${title}</b>`,
    "",
    `Pool: ${poolAddr}${grade}`,
    quoteLine,
    amt ? `Amount: ${escapeHtml(amt)}` : null,
    `Range: ${escapeHtml(range)}`,
    `SL / TP: ${escapeHtml(sl)} / ${escapeHtml(tp)}`,
    posId ? `ID: <code>${escapeHtml(String(posId))}</code>` : null,
    tx ? `Tx: <code>${escapeHtml(String(tx))}</code>` : null,
    `🕐 ${timestamp}`,
  ];
  return lines.filter((line) => line != null).join("\n");
}
