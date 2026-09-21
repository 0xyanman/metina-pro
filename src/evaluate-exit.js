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

function quoteLooksLikeUnclaimedUsd(usd, quoteAmt) {
  const idx = Number(usd);
  const q = Number(quoteAmt);
  if (!(idx >= 0.01) || !Number.isFinite(q) || q < 0) return false;
  return Math.abs(idx - q) <= Math.max(0.25, Math.abs(q) * 0.12);
}

function impliedMemePrice(position) {
  const pnl = position?.pnl && typeof position.pnl === "object" ? position.pnl : {};
  const amt = num(pnl.amount_meme ?? position?.amount_meme);
  const usd = num(pnl.amount_meme_usd ?? position?.amount_meme_usd);
  if (amt != null && amt > 0 && usd != null && usd > 0) {
    const px = usd / amt;
    if (Number.isFinite(px) && px > 0) return px;
  }
  return firstPositive(
    position?.current_price,
    pnl.current_price,
    position?.price_now,
    position?.spot_price,
  );
}

/**
 * Indexer often stores quote tokens as unclaimed USD, or a fake USD spike
 * (meme amount × wrong unit) while the real legs are still on the card.
 */
function unclaimedUsdFromFeeLegs(position) {
  const pnl = position?.pnl && typeof position.pnl === "object" ? position.pnl : {};
  const q = num(pnl.unclaimed_fees_quote ?? position?.unclaimed_fees_quote);
  const m = num(pnl.unclaimed_fees_meme ?? position?.unclaimed_fees_meme);
  const quote = String(pnl.quote_symbol || position?.quote_symbol || "").toUpperCase();
  const stable = /^(USDG|USDT|USDC|USD|DAI)$/.test(quote);
  const px = impliedMemePrice(position);
  let fromTokens = 0;
  if (stable && q != null && q > 0) fromTokens += q;
  if (m != null && m > 0 && px != null && px > 0) fromTokens += m * px;
  const stored = firstPositive(pnl.unclaimed_fee_usd, position?.unclaimed_fees_usd) || 0;
  if (stored > 0.005) {
    if (
      fromTokens > stored + 0.05
      && m != null
      && m > 0
      && quoteLooksLikeUnclaimedUsd(stored, stable ? q : stored)
    ) {
      return fromTokens;
    }
    if (fromTokens >= 0.01 && m != null && m > 0 && px != null && px > 0
      && stored > fromTokens * 1.5 && stored - fromTokens > 1) {
      return fromTokens;
    }
    return stored;
  }
  return fromTokens > 0.005 ? fromTokens : 0;
}

function feeBuckets(position) {
  const pnl = position?.pnl && typeof position.pnl === "object" ? position.pnl : {};
  const legs = unclaimedUsdFromFeeLegs(position);
  const stored = firstPositive(
    pnl.unclaimed_fee_usd,
    position?.unclaimed_fees_usd,
    pnl.unclaimed_fees_quote,
    position?.unclaimed_fees_quote,
  ) || 0;
  const unclaimed = legs >= 0.01 ? legs : stored;
  let claimed = firstPositive(
    pnl.fees_claimed_usd,
    pnl.fees_claimed_usdg,
    position?.fees_claimed_usd,
    pnl.collected_fees_usd,
    position?.collected_fees_usd,
  ) || 0;
  if (bidAskClaimedLooksLikeLeftoverPrincipal(position, claimed, unclaimed)) claimed = 0;
  return { pnl, unclaimed, claimed, fees: openFeesUsd(unclaimed, claimed) };
}

export function liveUnclaimedFeeUsd(position) {
  return feeBuckets(position).unclaimed;
}

export function liveClaimedFeeUsd(position) {
  return feeBuckets(position).claimed;
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
  const unclaimed = feeBuckets(position).unclaimed;
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

function isBidAskPosition(p) {
  const s = String(p?.strategy || p?.pnl?.strategy || "").toLowerCase().replace(/-/g, "_");
  if (s === "bid_ask" || s === "bidask") return true;
  const ids = p?.ladder_token_ids;
  return Array.isArray(ids) && ids.length > 1;
}

function positionAgeMs(position) {
  const t = Date.parse(
    position?.openedAt || position?.opened_at || position?.created_at || position?.createdAt,
  );
  const ageMs = Number.isFinite(t) ? Date.now() - t : null;
  const mins = Number(position?.age_minutes);
  const ageFromMins = Number.isFinite(mins) && mins >= 0 ? mins * 60_000 : null;
  return ageMs ?? ageFromMins;
}

/**
 * Fresh Bid-Ask overlay often stamps the other 3:2:1 rungs as collected fees
 * (5/6 of the deposit) while printed PnL is still ~0. That is not harvested fees.
 */
function bidAskClaimedLooksLikeLeftoverPrincipal(position, claimed, unclaimed) {
  if (!isBidAskPosition(position)) return false;
  if (!(claimed >= 1)) return false;
  // Real claim-lag: collected ≈ leftover unclaimed of the same harvest.
  if (unclaimed >= 0.01 && claimed <= unclaimed + Math.max(1, unclaimed * 0.25)) return false;
  const pnl = position?.pnl && typeof position.pnl === "object" ? position.pnl : {};
  const printed = num(pnl.pnl_usd ?? position?.pnl_usd);
  const printedAbs = printed == null ? 0 : Math.abs(printed);
  // Harvested fees show up in printed PnL. Leftover-rung stamps do not.
  if (printedAbs >= Math.max(1, claimed * 0.2)) return false;
  const cost = firstPositive(
    pnl.entry_value_usd,
    position?.initial_value_usd,
    position?.entry_value_usd,
    position?.input_value,
  );
  if (!(cost >= 1)) return false;
  const share = claimed / cost;
  if (share >= 0.4) return true;
  for (const frac of [1 / 2, 2 / 3, 5 / 6]) {
    if (Math.abs(share - frac) <= 0.03) return true;
  }
  return false;
}

/**
 * Fresh Bid-Ask cards often print pnl_usd=0 while unclaimed_fee_usd is a fake
 * spike (meme tokens as dollars). Do not Auto-TP from that until the NFT ages.
 * Hours-old real unclaimed still counts as Live PnL.
 */
export function skipTakeProfitOnFreshFeeSpike(position) {
  if (!isBidAskPosition(position)) return false;
  const { pnl, unclaimed, claimed } = feeBuckets(position);
  if (!(unclaimed >= 0.01) || claimed >= 0.01) return false;
  const inventory = lpInventoryUsd(position);
  const cost = entryCostUsd(position, inventory);
  if (!(cost >= 1)) return false;
  const live = livePnlUsd(position);
  if (live == null || Math.abs(live - unclaimed) > Math.max(1, unclaimed * 0.25)) return false;
  const printed = num(pnl.pnl_usd ?? position?.pnl_usd);
  const printedPct = num(pnl.pnl_pct ?? position?.pnl_pct);
  const printedFlat = (printed == null || Math.abs(printed) < 0.05)
    && (printedPct == null || Math.abs(printedPct) < 0.05);
  if (!printedFlat) return false;
  const age = positionAgeMs(position);
  const fresh = age != null && age >= 0 && age < 15 * 60_000;
  if (fresh && unclaimed > cost * 0.015) return true;
  if (age == null && unclaimed > cost * 0.025) return true;
  return false;
}

function bidAskRungCount(p) {
  const n = Number(p?.ladder_rungs);
  if (Number.isFinite(n) && n > 1) return n;
  const ids = p?.ladder_token_ids;
  return Array.isArray(ids) && ids.length > 1 ? ids.length : 1;
}

/**
 * Bid-Ask Auto TP/SL only on collapsed Live % with a full ladder mark.
 * Skip $0-without-sides, one indexed rung vs full cost, and wild indexer %.
 */
function bidAskExitReady(position, pnlPct) {
  if (!isBidAskPosition(position)) return true;
  const inventory = lpInventoryUsd(position);
  const cost = entryCostUsd(position, inventory);
  if (!(cost >= 1) || !(inventory >= 1)) return false;
  if (pnlPct != null && Number.isFinite(pnlPct) && Math.abs(pnlPct) > 200) return false;
  if (bidAskRungCount(position) >= 2 && inventory < cost * 0.4) return false;
  return true;
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
  if (!bidAskExitReady(position, pnlPct)) {
    return { action: null, reason: null, kind: null };
  }

  if (Number.isFinite(sl) && pnlPct <= sl) {
    return {
      action: "close",
      kind: "stop_loss",
      reason: `stop loss ${pnlPct.toFixed(2)}% <= ${sl}%`,
    };
  }
  if (Number.isFinite(tp) && pnlPct >= tp) {
    if (skipTakeProfitAfterClaim(position) || skipTakeProfitOnFreshFeeSpike(position)) {
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
