/**
 * Same rules as Metina Pro desk Auto TP/SL.
 * Close on the Open-card Live PNL (fee included), not the raw RPC inventory mark.
 * Empty SL/TP does not use hidden -50 / +10.
 */

function num(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function positiveFeeUsd(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Lifetime claimed + leftover unclaimed.
 * After Claim only, Unclaimed often still shows the harvest while Collected
 * already jumped — adding both fakes a huge Live PnL and trips Auto TP.
 */
export function openFeesUsd(unclaimed, claimed) {
  const u = positiveFeeUsd(unclaimed);
  const c = positiveFeeUsd(claimed);
  if (!(c >= 0.01) || !(u >= 0.01)) return u + c;
  if (c > u + Math.max(1, u * 0.25)) return u + c;
  return Math.max(u, c);
}

/** Skip Auto TP for a few minutes after Claim only — indexer lag. */
export const CLAIM_TP_COOLDOWN_MS = 180_000;

function feeBuckets(position) {
  const pnl = position?.pnl && typeof position.pnl === "object" ? position.pnl : {};
  const unclaimed = firstPositive(
    pnl.unclaimed_fee_usd,
    position?.unclaimed_fees_usd,
    pnl.unclaimed_fees_quote,
    position?.unclaimed_fees_quote,
  ) || 0;
  const claimed = firstPositive(
    pnl.fees_claimed_usd,
    pnl.fees_claimed_usdg,
    position?.fees_claimed_usd,
    pnl.collected_fees_usd,
    position?.collected_fees_usd,
  ) || 0;
  return { pnl, unclaimed, claimed, fees: openFeesUsd(unclaimed, claimed) };
}

function firstPositive(...vals) {
  for (const v of vals) {
    const n = num(v);
    if (n != null && n > 0) return n;
  }
  return null;
}

function lpSidesUsd(position) {
  const pnl = position?.pnl && typeof position.pnl === "object" ? position.pnl : {};
  const meme = num(pnl.amount_meme_usd ?? position?.amount_meme_usd);
  const quote = num(
    pnl.amount_eth_usd
    ?? pnl.amount_sol_usd
    ?? pnl.amount_quote_usd
    ?? position?.amount_eth_usd
    ?? position?.amount_sol_usd
    ?? position?.amount_quote_usd,
  );
  const sides = (meme > 0 ? meme : 0) + (quote > 0 ? quote : 0);
  return sides >= 0.01 ? sides : null;
}

function lpInventoryUsd(position) {
  const pnl = position?.pnl && typeof position.pnl === "object" ? position.pnl : {};
  // $0 Bid-Ask / LPAgent marks still have token sides — do not treat as −100% SL.
  const current = firstPositive(pnl.current_value_usd, position?.total_value_usd, position?.current_value_usd);
  const sides = lpSidesUsd(position);
  const unclaimed = firstPositive(
    pnl.unclaimed_fee_usd,
    position?.unclaimed_fees_usd,
    pnl.unclaimed_fees_quote,
    position?.unclaimed_fees_quote,
  ) || 0;
  // Prefer token sides when current already folded in unclaimed (would double-count).
  if (sides != null && current != null && unclaimed >= 0.01
    && current > sides + Math.max(1, unclaimed * 0.5)
    && Math.abs(current - (sides + unclaimed)) <= Math.max(1, unclaimed * 0.25)) {
    return sides;
  }
  if (current != null) return current;
  return sides;
}

function entryCostUsd(position, inventory) {
  const pnl = position?.pnl && typeof position.pnl === "object" ? position.pnl : {};
  const entry = firstPositive(
    pnl.entry_value_usd,
    position?.initial_value_usd,
    position?.entry_value_usd,
    position?.input_value,
    pnl.entry_value_eth,
  );
  if (entry != null) return entry;
  const onchain = num(pnl.onchain_pnl_pct ?? position?.onchain_pnl_pct);
  if (inventory != null && inventory > 0 && onchain != null && Math.abs(onchain) <= 500 && onchain > -99.9) {
    const cost = inventory / (1 + onchain / 100);
    if (cost > 0) return cost;
  }
  return null;
}

function mixedUnitPct(pct, liveUsd) {
  if (pct == null || !Number.isFinite(pct) || Math.abs(pct) <= 500) return false;
  return liveUsd == null || Math.abs(liveUsd) < 0.01;
}

/**
 * Live USD = LP inventory (meme + USDG/ETH/…) + claimed/unclaimed fees − cost.
 * Do not trust API pnl_pct when it is just the on-chain inventory mark.
 */
export function livePnlUsd(position) {
  const { pnl, fees } = feeBuckets(position);
  const printed = num(pnl.pnl_usd ?? position?.pnl_usd);
  const inventory = lpInventoryUsd(position);
  const cost = entryCostUsd(position, inventory);

  if (inventory != null && cost != null && cost > 0) {
    return inventory + fees - cost;
  }
  if ((printed == null || Math.abs(printed) < 0.005) && fees >= 0.01) {
    return (printed || 0) + fees;
  }
  return printed;
}

export function skipTakeProfitAfterClaim(position) {
  const { pnl, unclaimed, claimed } = feeBuckets(position);
  const at = position?.fees_claimed_at ?? pnl.fees_claimed_at;
  if (at) {
    const t = Date.parse(at);
    if (Number.isFinite(t) && Date.now() - t >= 0 && Date.now() - t < CLAIM_TP_COOLDOWN_MS) {
      return true;
    }
  }
  if (!(unclaimed >= 0.01) || !(claimed >= 0.01)) return false;
  if (claimed > unclaimed + Math.max(1, unclaimed * 0.25)) return false;
  const usd = num(pnl.pnl_usd ?? position?.pnl_usd);
  const nearZero = usd == null || Math.abs(usd) < 0.01;
  const looksLikeUnclaimed = usd != null && Math.abs(usd - unclaimed) <= Math.max(1, unclaimed * 0.2);
  return nearZero || looksLikeUnclaimed;
}

export function positionKey(p) {
  const venue = String(p?.poolType || p?.venue || "uniswap").toLowerCase();
  const chain = String(p?.chain || "").toLowerCase();
  const ids = Array.isArray(p?.ladder_token_ids)
    ? [...new Set(p.ladder_token_ids.map((id) => String(id || "").trim()).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    : [];
  if (ids.length > 1) {
    return `${venue}-${chain}-lad:${ids.join(",")}`;
  }
  return `${venue}-${chain}-${p?.position || p?.tokenId || ""}`;
}

/** Same % the Open card prints as Live PNL (inventory + fees vs cost). */
export function livePnlPct(position) {
  const pnl = position?.pnl && typeof position.pnl === "object" ? position.pnl : {};
  const display = num(pnl.pnl_pct ?? position?.pnl_pct);
  const onchain = num(pnl.onchain_pnl_pct ?? position?.onchain_pnl_pct);
  const inventory = lpInventoryUsd(position);
  const cost = entryCostUsd(position, inventory);
  const liveUsd = livePnlUsd(position);

  if (liveUsd != null && cost != null && cost > 0) {
    const fromMark = (liveUsd / cost) * 100;
    if (Number.isFinite(fromMark) && !mixedUnitPct(fromMark, liveUsd)) return fromMark;
  }

  if (display != null && Math.abs(display) >= 0.005 && !mixedUnitPct(display, liveUsd)) return display;
  if (liveUsd != null && Math.abs(liveUsd) >= 0.01 && inventory != null) {
    const inferred = inventory - liveUsd;
    if (inferred > 0) return (liveUsd / inferred) * 100;
  }
  if (display != null && !mixedUnitPct(display, liveUsd)) return display;
  if (onchain != null && !mixedUnitPct(onchain, liveUsd)) return onchain;
  return null;
}

export function evaluateExit(position) {
  if (!position || position.closed_on_chain || position.readonly) {
    return { action: null, reason: null, kind: null };
  }
  const venue = String(position.poolType || position.venue || "").toLowerCase();
  const pnl = position.pnl && typeof position.pnl === "object" ? position.pnl : {};

  const sl = num(position.stop_loss_pct);
  const tp = num(position.take_profit_pct);

  let pnlPct;
  if (venue !== "dlmm") {
    if (
      position.entry_seeded_from_principal === true
      || pnl.entry_seeded_from_principal === true
    ) {
      return { action: null, reason: null, kind: null };
    }
    pnlPct = livePnlPct(position);
  } else {
    pnlPct = num(pnl.pnl_pct ?? position.pnl_pct ?? pnl.pnl_sol_pct);
  }
  if (pnlPct == null) return { action: null, reason: null, kind: null };

  if (Number.isFinite(sl) && pnlPct <= sl) {
    return {
      action: "close",
      kind: "stop_loss",
      reason: `stop loss ${pnlPct.toFixed(2)}% <= ${sl}%`,
    };
  }
  if (Number.isFinite(tp) && pnlPct >= tp) {
    if (skipTakeProfitAfterClaim(position)) {
      return { action: null, reason: null, kind: null };
    }
    return {
      action: "close",
      kind: "take_profit",
      reason: `take profit ${pnlPct.toFixed(2)}% >= ${tp}%`,
    };
  }
  return { action: null, reason: null, kind: null };
}

export function watchLine(position) {
  const pnl = position?.pnl && typeof position.pnl === "object" ? position.pnl : {};
  const hit = evaluateExit(position);
  const onchain = num(pnl.onchain_pnl_pct ?? position?.onchain_pnl_pct);
  const live = livePnlPct(position);
  const tp = num(position?.take_profit_pct);
  const sl = num(position?.stop_loss_pct);
  const liveLabel = live != null ? live.toFixed(2) : "—";
  const onchainLabel = onchain != null ? onchain.toFixed(2) : "—";
  const tpLabel = tp != null ? ` tp=${tp}` : "";
  const slLabel = sl != null ? ` sl=${sl}` : "";
  const state = hit.kind || (live == null && onchain == null ? "no-pnl" : "watch");
  return `${position?.pair || position?.position}${slLabel}${tpLabel} live=${liveLabel} onchain=${onchainLabel} ${state}`;
}

export function closePayload(p, extra = {}) {
  const ids = Array.isArray(p.ladder_token_ids)
    ? p.ladder_token_ids.map((id) => String(id)).filter(Boolean)
    : [];
  return {
    venue: String(p.poolType || p.venue || "uniswap").toLowerCase() === "dlmm" ? "dlmm" : "uniswap",
    position: p.position || p.tokenId,
    tokenId: p.position || p.tokenId,
    chain: p.chain,
    pair: p.pair,
    pool: p.pool,
    mint: p.mint || p.base_mint,
    fee: p.fee,
    version: p.version,
    dex: p.dex,
    strategy: p.strategy || p.pnl?.strategy || null,
    ladder_id: p.ladder_id || null,
    ladder_token_ids: ids.length > 1 ? ids : undefined,
    snapshot: p,
    ...extra,
  };
}
