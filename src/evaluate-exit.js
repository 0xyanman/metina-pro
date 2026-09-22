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

function quoteIsStable(position) {
  const q = String(position?.quote_symbol || position?.pnl?.quote_symbol || "").toUpperCase();
  return /^(USDG|USDT|USDC|USD|DAI)$/.test(q);
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

function costRemainingFrac(position) {
  const pnl = position?.pnl && typeof position.pnl === "object" ? position.pnl : {};
  const n = Number(position?.cost_remaining_frac ?? pnl.cost_remaining_frac);
  if (Number.isFinite(n) && n > 0 && n <= 1) return n;
  return null;
}

/** LPAgent keeps the original deposit after a 50% remove — scale like Pro. */
function scaledOpenCostUsd(position) {
  const pnl = position?.pnl && typeof position.pnl === "object" ? position.pnl : {};
  const frac = costRemainingFrac(position);
  const orig = firstPositive(position?.original_initial_value_usd, pnl.original_initial_value_usd);
  const stored = firstPositive(pnl.entry_value_usd, position?.entry_value_usd, position?.initial_value_usd);
  if (frac != null && frac < 0.999) {
    const basis = orig || stored;
    if (basis != null) return basis * frac;
  }
  if (orig != null && stored != null && stored < orig * 0.995) return stored;
  return null;
}

function entryCostUsd(position, inventory) {
  const pnl = position?.pnl && typeof position.pnl === "object" ? position.pnl : {};
  const scaled = scaledOpenCostUsd(position);
  if (scaled != null && scaled >= 0.01) return scaled;
  const entry = firstPositive(
    pnl.entry_value_usd,
    position?.initial_value_usd,
    position?.entry_value_usd,
    position?.input_value,
    quoteIsStable(position) ? pnl.entry_value_eth : null,
    quoteIsStable(position) ? position?.entry_value_eth : null,
  );
  const rungs = bidAskRungCount(position);
  const mark = firstPositive(pnl.current_value_usd, position?.total_value_usd, position?.current_value_usd, inventory);
  const eth = quoteIsStable(position)
    ? firstPositive(pnl.entry_value_eth, position?.entry_value_eth)
    : null;
  if (rungs > 1 && mark > 0 && entry > 0 && mark > entry * 1.55) {
    if (eth > 0 && eth >= mark * 0.7) return eth;
    return mark;
  }
  if (rungs > 1 && mark > 0 && entry > 0 && entry > mark * 2.4) {
    if (eth > 0 && eth <= mark * 1.2) return eth;
    return mark;
  }
  if (entry != null) return entry;
  // Do not invert onchain_pnl_pct when Pro already flagged it unreliable
  // (AU/USDG: -7.74% on-chain vs -1.43% from pnl_usd / inventory).
  const unreliable = position?.pnl_reliable === false || pnl.pnl_reliable === false;
  if (unreliable) return null;
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

function shouldPreferLpagentOpenPnl(p) {
  if (!p) return false;
  const chain = String(p.chain || p.pnl?.chain || "").toLowerCase();
  const src = String(p.discover_source || p.source || "").toLowerCase();
  if (chain === "robinhood" && (src === "lpagent" || src === "krystal")) return true;
  if (src !== "lpagent") return false;
  if (chain === "solana" || chain === "sol") return true;
  const pool = String(p.poolType || p.protocol || "").toLowerCase();
  return pool === "dlmm";
}

/** Live EVM Bid-Ask: inventory + unclaimed − cost, without adding fees twice. */
export function bidAskOpenMarkUsd({ inventory, cost, pending = 0 } = {}) {
  const inv = Number(inventory);
  const c = Number(cost);
  const fee = Number(pending);
  const pendingUsd = Number.isFinite(fee) && fee > 0 ? fee : 0;
  if (!Number.isFinite(inv) || !Number.isFinite(c) || !(c > 0)) return null;
  const gap = inv - c;
  const inventoryAlreadyHasFees = pendingUsd >= 0.01
    && Math.abs(gap - pendingUsd) <= Math.max(0.5, pendingUsd * 0.25);
  return inventoryAlreadyHasFees ? gap : gap + pendingUsd;
}

function bidAskLiveMarkIsLeftover(mark, pending) {
  const m = Number(mark);
  const fee = Number(pending);
  const pendingUsd = Number.isFinite(fee) && fee > 0 ? fee : 0;
  if (!Number.isFinite(m) || !(m > 0)) return false;
  if (pendingUsd >= 0.01 && Math.abs(m - pendingUsd) <= Math.max(1, pendingUsd * 0.35)) {
    return false;
  }
  return true;
}

/**
 * LPAgent often prints fee ROI as Live PnL while inventory is underwater
 * (VISTA +$80 fees vs −$640 mark). Same gate as Metina Pro.
 */
function feePrintHidesOpenMark(printedUsd, feeUsd, markUsd, costUsd) {
  const printed = Number(printedUsd);
  const mark = Number(markUsd);
  const fees = Number(feeUsd) > 0 ? Number(feeUsd) : 0;
  if (!Number.isFinite(printed) || !Number.isFinite(mark)) return false;
  const gap = Math.abs(mark - printed);
  if (gap <= 5) return false;
  const looksLikeFeePrint = fees >= 0.01
    && Math.abs(printed - fees) <= Math.max(1, fees * 0.2);
  const opposite = Math.sign(printed) !== 0 && Math.sign(mark) !== 0
    && Math.sign(printed) !== Math.sign(mark);
  if (opposite && !looksLikeFeePrint) return false;
  if (opposite) return true;
  if (!looksLikeFeePrint) return false;
  return gap > Math.max(fees, Math.abs(printed), (Number(costUsd) || 0) * 0.03);
}

function isSolanaDlmm(p) {
  const chain = String(p?.chain || p?.pnl?.chain || "").toLowerCase();
  if (chain === "solana" || chain === "sol") return true;
  const pool = String(p?.poolType || p?.protocol || p?.venue || "").toLowerCase();
  return pool === "dlmm" || pool === "damm";
}

/**
 * Live USD = same Open-card mark as Metina Pro (inventory + fees − cost).
 * Robinhood LPAgent leftover/incomplete CURRENT can print a plus while the
 * indexer is IL-red — keep that minus so TP does not fire on a remint leftover.
 */
export function livePnlUsd(position) {
  const { pnl, fees, unclaimed } = feeBuckets(position);
  const printed = num(pnl.pnl_usd ?? position?.pnl_usd ?? pnl.indexer_pnl_usd);
  const inventory = lpInventoryUsd(position);
  const cost = entryCostUsd(position, inventory);
  const preferIndexer = shouldPreferLpagentOpenPnl(position);
  const bidAsk = isBidAskPosition(position) && !isSolanaDlmm(position);

  if (inventory != null && cost != null && cost > 0) {
    const withoutFees = inventory - cost;
    if (
      fees >= 0.01
      && Math.abs(withoutFees - fees) <= Math.max(0.5, fees * 0.25)
    ) {
      return withoutFees;
    }
    if (bidAsk) {
      // Leftover 3:2:1 "claimed" is already wiped in feeBuckets.
      const pending = fees;
      const mark = bidAskOpenMarkUsd({ inventory, cost, pending });
      const idx = printed;
      if (
        preferIndexer
        && idx != null
        && idx < 0
        && mark > 0
        && bidAskLiveMarkIsLeftover(mark, pending)
      ) return idx;
      return mark;
    }
    const mark = inventory + fees - cost;
    const printedLooksLikeFees = fees >= 0.01 && printed != null
      && Math.abs(printed - fees) <= Math.max(1, fees * 0.2);
    if ((preferIndexer || printedLooksLikeFees) && feePrintHidesOpenMark(printed, fees, mark, cost)) {
      if (preferIndexer && printed < 0 && mark > 0 && !printedLooksLikeFees) return printed;
      return mark;
    }
    if (preferIndexer && printed != null) return printed;
    return mark;
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

  // Unreliable + no real deposit: % from pnl_usd vs inventory, not the
  // on-chain mark that often got copied into pnl_pct (AU/USDG tautology).
  const unreliable = position?.pnl_reliable === false || pnl.pnl_reliable === false;
  if (unreliable && liveUsd != null && Math.abs(liveUsd) >= 0.01 && inventory != null) {
    const inferred = inventory - liveUsd;
    if (inferred > 0) {
      const fromInv = (liveUsd / inferred) * 100;
      if (Number.isFinite(fromInv) && !mixedUnitPct(fromInv, liveUsd)) return fromInv;
    }
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
  const cost = firstPositive(
    pnl.entry_value_usd,
    position?.initial_value_usd,
    position?.entry_value_usd,
    position?.input_value,
  );
  if (!(cost >= 1)) return false;
  const share = claimed / cost;
  // 3:2:1 leftover rungs are ≥40% of deposit. Overlay may copy that
  // stamp into pnl_usd — still not harvested fees.
  if (share >= 0.4) return true;
  const printed = num(pnl.pnl_usd ?? position?.pnl_usd);
  const printedAbs = printed == null ? 0 : Math.abs(printed);
  if (printedAbs >= Math.max(1, claimed * 0.2)) return false;
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
  const { unclaimed, claimed } = feeBuckets(position);
  if (!(unclaimed >= 0.01) || claimed >= 0.01) return false;
  const inventory = lpInventoryUsd(position);
  const cost = entryCostUsd(position, inventory);
  if (!(cost >= 1)) return false;
  const live = livePnlUsd(position);
  if (live == null || Math.abs(live - unclaimed) > Math.max(1, unclaimed * 0.25)) return false;
  // Inventory still ≈ deposit: the “profit” is only the fee print.
  // Overlay may fold the spike into current_value, so also treat
  // (inventory − unclaimed) ≈ cost as flat.
  const maxDrift = Math.max(1, cost * 0.015);
  const inventoryFlat = inventory != null && Math.abs(inventory - cost) <= maxDrift;
  const inventoryFlatExFee = inventory != null
    && Math.abs((inventory - unclaimed) - cost) <= maxDrift;
  if (!inventoryFlat && !inventoryFlatExFee) return false;
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
