import { positionKey, livePnlPct, livePnlUsd, liveUnclaimedFeeUsd, liveClaimedFeeUsd } from "./evaluate-exit.js";
import { escapeHtml } from "./telegram.js";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const CIRCLED_NUMBERS = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨", "⑩", "⑪", "⑫", "⑬", "⑭", "⑮", "⑯", "⑰", "⑱", "⑲", "⑳"];

export function formatTimestampWIB(date = new Date()) {
  const d = new Date(date.getTime() + 7 * 60 * 60 * 1000);
  const day = d.getUTCDate();
  const month = MONTHS[d.getUTCMonth()];
  const year = d.getUTCFullYear();
  const hour = String(d.getUTCHours()).padStart(2, "0");
  const min = String(d.getUTCMinutes()).padStart(2, "0");
  return `${day} ${month} ${year}, ${hour}:${min} WIB`;
}

function num(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function formatNumber(v, maxSig = 4) {
  const n = num(v);
  if (n == null) return "";
  if (n === 0) return "0";
  if (Math.abs(n) >= 10_000) return n.toFixed(2);
  if (Math.abs(n) >= 1) return Number.parseFloat(n.toPrecision(maxSig + 1)).toString();
  return Number.parseFloat(n.toPrecision(maxSig)).toString();
}

export function formatUsd(v, showSign = false) {
  const n = num(v);
  if (n == null) return "";
  if (n === 0) return "$0.00";
  if (n > 0) return showSign ? `+$${n.toFixed(2)}` : `$${n.toFixed(2)}`;
  return `-$${Math.abs(n).toFixed(2)}`;
}

export function formatPct(v, showSign = true) {
  const n = num(v);
  if (n == null) return "";
  if (n === 0) return "0.00%";
  if (n > 0) return showSign ? `+${n.toFixed(2)}%` : `${n.toFixed(2)}%`;
  return `${n.toFixed(2)}%`;
}

function buildPriceBar(now, min, max, barWidth = 24) {
  if (min == null || max == null || max <= min) return "";
  if (now == null) return "=".repeat(barWidth);
  if (now < min) return "●" + "·".repeat(barWidth - 1);
  if (now > max) return "·".repeat(barWidth - 1) + "●";

  const ratio = (now - min) / (max - min);
  const dotIdx = Math.min(barWidth - 1, Math.max(0, Math.round(ratio * (barWidth - 1))));
  const chars = new Array(barWidth).fill("=");
  chars[dotIdx] = "●";
  return chars.join("");
}

export function formatPriceRange(position) {
  if (!position || typeof position !== "object") return "";

  const pnl = position.pnl && typeof position.pnl === "object" ? position.pnl : {};
  const ticks = position.ticks && typeof position.ticks === "object" ? position.ticks : {};

  const minRaw = position.price_min ?? position.min_price ?? position.range_min
    ?? position.price_lower ?? position.tick_lower_price ?? ticks.lower_price;
  const nowRaw = position.price_now ?? position.current_price ?? position.spot_price
    ?? position.price ?? position.pool?.price ?? pnl.price_now;
  const maxRaw = position.price_max ?? position.max_price ?? position.range_max
    ?? position.price_upper ?? position.tick_upper_price ?? ticks.upper_price;

  const min = num(minRaw);
  const now = num(nowRaw);
  const max = num(maxRaw);

  const tickLower = position.tick_lower ?? ticks.lower ?? position.lower_tick;
  const tickUpper = position.tick_upper ?? ticks.upper ?? position.upper_tick;

  if (min == null && max == null && tickLower == null) return "";

  const lines = [];

  const parts = [];
  if (min != null) parts.push(`MIN ${formatNumber(min)}`);
  if (now != null) parts.push(`NOW ${formatNumber(now)}`);
  if (max != null) parts.push(`MAX ${formatNumber(max)}`);
  if (parts.length > 0) {
    lines.push(`Range: ${parts.join(" · ")}`);
  }

  if (tickLower != null && tickUpper != null) {
    lines.push(`       tick ${tickLower} → ${tickUpper}`);
  }

  const bar = buildPriceBar(now, min, max);
  if (bar) {
    lines.push(`       [${bar}]`);
  }

  return lines.join("\n");
}

export function formatPnlBlock(position, labelPrefix = "") {
  if (!position || typeof position !== "object") return "";
  const pnl = position.pnl && typeof position.pnl === "object" ? position.pnl : {};

  const livePct = livePnlPct(position);
  const liveUsd = livePnlUsd(position) ?? num(pnl.pnl_usd ?? position.pnl_usd);
  const onchainPct = num(pnl.onchain_pnl_pct ?? position.onchain_pnl_pct);
  const valueUsd = num(pnl.current_value_usd ?? position.total_value_usd ?? position.current_value_usd);
  const unclaimedUsd = [liveUnclaimedFeeUsd(position), pnl.unclaimed_fee_usd, position.unclaimed_fees_usd, pnl.unclaimed_fees_quote, position.unclaimed_fees_quote]
    .map(num).find((n) => n != null && n > 0) ?? num(pnl.unclaimed_fee_usd ?? position.unclaimed_fees_usd);
  const claimedUsd = liveClaimedFeeUsd(position);

  const lines = [];
  const header = labelPrefix ? `PNL (${labelPrefix}):` : "PNL:";

  if (livePct != null) {
    const usdPart = liveUsd != null ? `  (${formatUsd(liveUsd, true)})` : "";
    lines.push(`  Live:    ${formatPct(livePct, true)}${usdPart}`);
  }
  if (onchainPct != null) {
    lines.push(`  On-chain: ${formatPct(onchainPct, true)}`);
  }
  if (valueUsd != null) {
    lines.push(`  Value:   ${formatUsd(valueUsd)}`);
  }
  if (unclaimedUsd != null) {
    lines.push(`  Unclaimed fees: ${formatUsd(unclaimedUsd)}`);
  }
  if (claimedUsd >= 0.01) {
    lines.push(`  Collected fees: ${formatUsd(claimedUsd)}`);
  }

  if (lines.length === 0) return "";
  return `${header}\n${lines.join("\n")}`;
}

export function formatCompactNumber(v) {
  const n = num(v);
  if (n == null) return "";
  if (n === 0) return "0";
  if (Math.abs(n) >= 1_000_000) {
    return `${Number((n / 1_000_000).toFixed(2))}M`;
  }
  if (Math.abs(n) >= 1_000) {
    return `${Number((n / 1_000).toFixed(2))}k`;
  }
  return formatNumber(n);
}

function formatTokenLine(amt, usd, sym, isStableQuote = false) {
  if (amt == null && usd == null) return null;
  if (isStableQuote && usd != null) {
    return formatUsd(usd);
  }
  const parts = [];
  if (amt != null && (amt > 0 || usd != null)) {
    parts.push(`${formatCompactNumber(amt)} ${sym}`.trim());
  } else if (sym) {
    parts.push(sym);
  }
  if (usd != null) {
    parts.push(`(${formatUsd(usd)})`);
  }
  return parts.length > 0 ? parts.join(" ") : null;
}

export function formatAssetsBlock(position) {
  if (!position || typeof position !== "object") return "";
  const pnl = position.pnl && typeof position.pnl === "object" ? position.pnl : {};

  const memeAmt = num(pnl.amount_meme ?? position.amount_meme);
  const memeUsd = num(pnl.amount_meme_usd ?? position.amount_meme_usd);
  const memeSym = pnl.meme_symbol || position.meme_symbol || position.symbol || (position.pair ? position.pair.split("/")[0] : "");

  const ethAmt = num(pnl.amount_eth ?? position.amount_eth);
  const ethUsd = num(pnl.amount_eth_usd ?? position.amount_eth_usd);
  const ethSym = pnl.quote_symbol || position.quote_symbol || (position.pair ? position.pair.split("/")[1] : "") || "";

  const memeLine = formatTokenLine(memeAmt, memeUsd, memeSym);
  const isStableQuote = ["USDG", "USDT", "USDC", "USD", "DAI"].includes(String(ethSym).toUpperCase());
  const ethLine = formatTokenLine(ethAmt, ethUsd, ethSym, isStableQuote);

  const lines = [];
  if (memeLine) lines.push(`  ${memeLine}`);
  if (ethLine) lines.push(`  ${ethLine}`);

  if (lines.length === 0) return "";
  return `Assets:\n${lines.join("\n")}`;
}

export function formatAllPnlSummary(positions) {
  if (!Array.isArray(positions) || positions.length === 0) return "";

  let totalUsd = 0;
  let hasUsd = false;
  let livePctSum = 0;
  let livePctCount = 0;

  for (const p of positions) {
    const pnl = p?.pnl && typeof p.pnl === "object" ? p.pnl : {};
    const usd = livePnlUsd(p) ?? num(pnl.pnl_usd ?? p?.pnl_usd);
    if (usd != null) {
      totalUsd += usd;
      hasUsd = true;
    }
    const lp = livePnlPct(p);
    if (lp != null) {
      livePctSum += lp;
      livePctCount += 1;
    }
  }

  const parts = [];
  if (hasUsd) {
    parts.push(formatUsd(totalUsd, true));
  }
  if (livePctCount > 0) {
    const avg = livePctSum / livePctCount;
    if (positions.length === 1) {
      parts.push(`Live ${formatPct(avg, true)}`);
    } else {
      parts.push(`Live avg ${formatPct(avg, true)}`);
    }
  }

  if (parts.length === 0) return "";
  return `All PNL: ${parts.join(" · ")}`;
}

function extractPositionTags(p) {
  const tags = [];
  if (p.version) tags.push(p.version.toUpperCase());
  if (p.poolType?.toLowerCase() === "dlmm") tags.push("DLMM");
  const strategy = String(p.strategy || p.pnl?.strategy || "").toLowerCase().replace(/-/g, "_");
  if (strategy === "bid_ask" || (Array.isArray(p.ladder_token_ids) && p.ladder_token_ids.length > 1)) {
    tags.push("Bid-Ask");
  }
  if (p.dex) tags.push(p.dex);
  if (p.source) tags.push(p.source);
  if (p.agent || p.lp_agent || p.is_lp_agent) tags.push("LPAgent");
  return tags;
}

function formatPositionCard(p, index, totalCount) {
  const pair = p.pair || p.position || p.tokenId || "Unknown";
  const chain = p.chain ? p.chain.charAt(0).toUpperCase() + p.chain.slice(1) : "";
  const tags = extractPositionTags(p);

  const numPrefix = totalCount > 1
    ? (CIRCLED_NUMBERS[index] || `(${index + 1}) `) + " "
    : "";

  const posId = p.position || p.tokenId || "";
  const titleLine = posId
    ? `<b>${numPrefix}${escapeHtml(pair)}</b> · ID: <code>${escapeHtml(posId)}</code>`
    : `<b>${numPrefix}${escapeHtml(pair)}</b>`;

  const chainParts = [];
  if (chain) chainParts.push(`Chain: ${escapeHtml(chain)}`);
  if (tags.length > 0) chainParts.push(escapeHtml(tags.join(" · ")));
  const chainLine = chainParts.join(" · ");

  const sl = num(p.stop_loss_pct);
  const tp = num(p.take_profit_pct);
  const slStr = sl != null ? `${sl}%` : "—";
  const tpStr = tp != null ? `${tp}%` : "—";
  const slTpLine = `SL: ${slStr} · TP: ${tpStr}`;

  const pnlBlock = formatPnlBlock(p);
  const assetsBlock = formatAssetsBlock(p);
  const rangeBlock = formatPriceRange(p);

  const cardLines = [titleLine];
  if (chainLine) cardLines.push(chainLine);
  cardLines.push(slTpLine);
  if (pnlBlock) cardLines.push(pnlBlock);
  if (assetsBlock) cardLines.push(assetsBlock);
  if (rangeBlock) cardLines.push(`<code>${escapeHtml(rangeBlock)}</code>`);

  return cardLines.join("\n");
}

export function sortOpenPositions(positions) {
  return [...positions].sort((a, b) => {
    const pairA = String(a.pair || a.position || a.tokenId || "").toLowerCase();
    const pairB = String(b.pair || b.position || b.tokenId || "").toLowerCase();
    return pairA.localeCompare(pairB);
  });
}

export function formatOpenSummary(positions) {
  const list = Array.isArray(positions) ? positions : [];
  if (list.length === 0) return "";

  const sorted = sortOpenPositions(list);

  const count = sorted.length;
  const timestamp = formatTimestampWIB();
  const allPnl = formatAllPnlSummary(sorted);

  const headerLines = [
    `📂 <b>Open Positions · ${count} active</b>`,
    `🕐 ${timestamp}`,
  ];
  if (allPnl) headerLines.push(allPnl);
  const header = headerLines.join("\n");

  const cardSeparator = "\n\n────────\n\n";
  const cards = [];
  let currentLen = header.length + 2;

  for (let i = 0; i < count; i++) {
    const card = formatPositionCard(sorted[i], i, count);
    const additionLen = (cards.length > 0 ? cardSeparator.length : 2) + card.length;

    if (currentLen + additionLen > 3500 && cards.length > 0) {
      const remaining = count - cards.length;
      cards.push(`… +${remaining} posisi lain (potong)`);
      break;
    }

    cards.push(card);
    currentLen += additionLen;
  }

  return `${header}\n\n${cards.join(cardSeparator)}`;
}

function getTriggerLabel(kind, reason) {
  if (kind === "take_profit") return "Take Profit";
  if (kind === "stop_loss") return "Stop Loss";
  if (reason && reason !== "manual_or_external") return reason;
  return "Manual / external";
}

export function formatCloseMessage({ position, reason, kind, tx, error, dry }) {
  const p = position || {};
  const pair = p.pair || p.position || p.tokenId || "Unknown";
  const chain = p.chain ? p.chain.charAt(0).toUpperCase() + p.chain.slice(1) : "";
  const timestamp = formatTimestampWIB();

  const titleMeta = chain ? `${escapeHtml(pair)} · ${escapeHtml(chain)}` : escapeHtml(pair);
  const triggerLabel = getTriggerLabel(kind, reason);

  if (dry) {
    const livePct = livePnlPct(p);
    const liveStr = livePct != null ? formatPct(livePct, true) : "—";
    const threshold = kind === "take_profit"
      ? `TP ${p.take_profit_pct ?? "—"}%`
      : `SL ${p.stop_loss_pct ?? "—"}%`;

    return [
      `🧪 <b>[DRY] Would Close</b>`,
      `<b>${titleMeta}</b>`,
      "",
      `Trigger: ${escapeHtml(triggerLabel)}`,
      `Live PNL: ${liveStr} (threshold ${threshold})`,
      `🕐 ${timestamp}`,
    ].join("\n");
  }

  if (error) {
    return [
      `⚠️ <b>Close Failed</b>`,
      `<b>${titleMeta}</b>`,
      "",
      `Trigger: ${escapeHtml(triggerLabel)}`,
      `Reason: ${escapeHtml(error)}`,
      `🕐 ${timestamp}`,
    ].join("\n");
  }

  const pnlPrefix = reason === "manual_or_external" ? "last seen" : "";
  const pnlBlock = formatPnlBlock(p, pnlPrefix);
  const rangeBlock = formatPriceRange(p);

  const lines = [
    `🔴 <b>Position Closed</b>`,
    `<b>${titleMeta}</b>`,
    "",
    `Trigger: ${escapeHtml(triggerLabel)}`,
  ];

  if (pnlBlock) lines.push(pnlBlock);
  if (rangeBlock) lines.push(`<code>${escapeHtml(rangeBlock)}</code>`);
  if (tx) lines.push(`Tx: <code>${escapeHtml(tx)}</code>`);
  lines.push(`🕐 ${timestamp}`);

  return lines.join("\n");
}

export function createPositionTracker() {
  const previousOpenMap = new Map();
  const justClosedKeys = new Set();
  const dryNotifiedKeys = new Set();

  return {
    getPreviousMap: () => previousOpenMap,
    markWorkerClosed: (key) => {
      justClosedKeys.add(key);
    },
    /** Returns true the first time this key is marked in a DRY streak. */
    markDryNotified: (key) => {
      if (dryNotifiedKeys.has(key)) return false;
      dryNotifiedKeys.add(key);
      return true;
    },
    pruneDryNotified: (activeKeys) => {
      for (const key of dryNotifiedKeys) {
        if (!activeKeys.has(key)) dryNotifiedKeys.delete(key);
      }
    },
    async notifyCycle({ open, discover, notifier }) {
      if (!notifier?.isEnabled()) return;

      const currentOpen = Array.isArray(open) ? open : [];
      const currentKeys = new Set(currentOpen.map((p) => positionKey(p)));

      // 1. If discover tick and open positions exist -> send summary
      if (discover && currentOpen.length > 0) {
        const summary = formatOpenSummary(currentOpen);
        if (summary) await notifier.send(summary);
      }

      // 2. Diff keys vs previous -> check if any closed externally
      if (previousOpenMap.size > 0) {
        for (const [key, oldPos] of previousOpenMap.entries()) {
          if (!currentKeys.has(key) && !justClosedKeys.has(key)) {
            const msg = formatCloseMessage({
              position: oldPos,
              reason: "manual_or_external",
              kind: "manual",
            });
            await notifier.send(msg);
          }
        }
      }

      // 3. Update previousOpenMap and clear justClosedKeys
      previousOpenMap.clear();
      for (const p of currentOpen) {
        previousOpenMap.set(positionKey(p), p);
      }
      justClosedKeys.clear();
    },
  };
}

export function formatHelpMessage() {
  return [
    "🤖 <b>Metina TPSL Bot Commands</b>",
    "",
    "• <code>/refresh</code> - Update &amp; kirim ringkasan posisi open terkini",
    "• <code>/open &lt;0x token&gt; &lt;amount&gt; [chain]</code> - Buka LP via Metina Pro. Quote default: robinhood=USDG, base=USDC, bsc=USDT. Side: <code>single</code> / <code>double</code> / <code>token</code> (butuh LIVE_OPEN=1)",
    "• <code>/close all</code> - Tutup semua posisi open (butuh LIVE_CLOSE=1)",
    "• <code>/close profit</code> - Tutup hanya posisi yang sedang profit (butuh LIVE_CLOSE=1)",
    "• <code>/close &lt;id atau nomor&gt;</code> - Tutup posisi tertentu (contoh: <code>/close 933596</code> atau <code>/close 1</code> sesuai nomor di ringkasan)",
    "• <code>/help</code> - Tampilkan panduan ini",
  ].join("\n");
}

