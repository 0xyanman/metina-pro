/**
 * Desk Bid-Ask is 3 Uniswap NFTs / 1 LP. The positions API still lists rungs.
 * Collapse them here so SL/TP and Telegram treat one ladder as one card.
 */

function num(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function firstFinite(...vals) {
  for (const v of vals) {
    const n = num(v);
    if (n != null) return n;
  }
  return null;
}

function firstPositive(...vals) {
  for (const v of vals) {
    const n = num(v);
    if (n != null && n > 0) return n;
  }
  return null;
}

function inventoryUsdFromSides(m) {
  const pnl = m?.pnl && typeof m.pnl === "object" ? m.pnl : {};
  const q = num(pnl.amount_eth_usd ?? m?.amount_quote_usd ?? m?.amount_eth_usd ?? pnl.amount_sol_usd ?? m?.amount_sol_usd);
  const meme = num(pnl.amount_meme_usd ?? m?.amount_meme_usd);
  const sum = (q > 0 ? q : 0) + (meme > 0 ? meme : 0);
  return sum > 0 ? sum : null;
}

function posTokenId(p) {
  return String(p?.tokenId || p?.position || "");
}

export function parseLadderIdList(raw) {
  if (Array.isArray(raw)) return [...new Set(raw.map((id) => String(id || "").trim()).filter(Boolean))];
  if (raw == null || raw === "") return [];
  return [String(raw).trim()].filter(Boolean);
}

function openedMs(p) {
  const t = Date.parse(p?.openedAt || p?.opened_at || p?.created_at || p?.createdAt);
  return Number.isFinite(t) ? t : null;
}

function ladderPlaceKey(p) {
  const chain = String(p?.chain || "").toLowerCase();
  if (chain === "solana" || p?.poolType === "dlmm") return "";
  const pool = String(p?.pool || p?.poolAddress || "").toLowerCase();
  const pair = String(p?.pair || "").toLowerCase().replace(/\s+/g, "");
  const place = pool || pair;
  if (!place) return "";
  return `${chain}|${place}`;
}

function walletOf(p) {
  return String(p?.wallet || "").toLowerCase();
}

function splitByWallet(members) {
  const named = new Map();
  const loose = [];
  for (const p of members) {
    const w = walletOf(p);
    if (!w) {
      loose.push(p);
      continue;
    }
    if (!named.has(w)) named.set(w, []);
    named.get(w).push(p);
  }
  if (!named.size) return loose.length ? [loose] : [];
  if (named.size === 1) return [[...named.values().next().value, ...loose]];
  const out = [...named.values()];
  if (loose.length) out.push(loose);
  return out;
}

function completeLadderStamp(p) {
  return Boolean(p?.ladder_id) && parseLadderIdList(p.ladder_token_ids).length >= 3;
}

function hasTicks(p) {
  return Number.isFinite(Number(p?.tick_lower ?? p?.pnl?.tick_lower))
    && Number.isFinite(Number(p?.tick_upper ?? p?.pnl?.tick_upper));
}

function tickLo(p) {
  return Number(p?.tick_lower ?? p?.pnl?.tick_lower);
}

function tickHi(p) {
  return Number(p?.tick_upper ?? p?.pnl?.tick_upper);
}

function openedTogether(rows) {
  const ts = rows.map(openedMs).filter((t) => t != null);
  if (ts.length >= 2) return Math.max(...ts) - Math.min(...ts) <= 90_000;
  const ids = rows.map((p) => Number(posTokenId(p))).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  return ids.length >= 2 && ids[ids.length - 1] - ids[0] <= ids.length + 1;
}

function consecutiveIds(rows) {
  const ids = rows.map((p) => Number(posTokenId(p))).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  return ids.length === rows.length
    && ids.length >= 2
    && ids[ids.length - 1] - ids[0] <= ids.length + 1;
}

function adjacentTickRun(members) {
  const withTicks = members.filter(hasTicks);
  if (withTicks.length < 2) return null;
  const sorted = [...withTicks].sort((a, b) => tickLo(a) - tickLo(b));
  for (let i = 1; i < sorted.length; i += 1) {
    if (tickHi(sorted[i - 1]) !== tickLo(sorted[i])) return null;
  }
  return sorted;
}

function isLikelyLadder(group) {
  if (!group || group.length < 2 || group.length > 3) return false;
  if (adjacentTickRun(group) && openedTogether(group)) return true;
  if (consecutiveIds(group) && (group.length >= 3 || openedTogether(group))) return true;
  return group.length >= 3 && openedTogether(group);
}

function relatedToGroup(group, p) {
  if (!p || group.includes(p)) return false;
  const next = [...group, p];
  return Boolean(adjacentTickRun(next) || consecutiveIds(next) || openedTogether(next));
}

function absorbRelated(leftover, group) {
  const out = [...(group || [])];
  let grew = true;
  while (grew && out.length < 3) {
    grew = false;
    for (const p of leftover) {
      if (out.includes(p) || out.length >= 3) continue;
      if (!relatedToGroup(out, p)) continue;
      out.push(p);
      leftover.delete(p);
      grew = true;
    }
  }
  return out;
}

function takeCluster(leftover, group, clusters) {
  const grown = absorbRelated(leftover, group);
  if (!isLikelyLadder(grown)) return false;
  grown.forEach((p) => leftover.delete(p));
  clusters.push(grown);
  return true;
}

function clusterLadderMembers(members) {
  const leftover = new Set(members);
  const clusters = [];

  const withTicks = [...leftover].filter(hasTicks).sort((a, b) => tickLo(a) - tickLo(b));
  let run = [];
  for (const p of withTicks) {
    if (!run.length) {
      run = [p];
      continue;
    }
    const prev = run[run.length - 1];
    if (tickHi(prev) === tickLo(p) && run.length < 3) {
      run.push(p);
      continue;
    }
    takeCluster(leftover, run, clusters);
    run = [p];
  }
  takeCluster(leftover, run, clusters);

  const timed = [...leftover]
    .filter((p) => openedMs(p) != null)
    .sort((a, b) => openedMs(a) - openedMs(b));
  let window = [];
  for (const p of timed) {
    if (!window.length) {
      window = [p];
      continue;
    }
    if (openedMs(p) - openedMs(window[0]) <= 90_000 && window.length < 3) {
      window.push(p);
      continue;
    }
    takeCluster(leftover, window, clusters);
    window = [p];
  }
  takeCluster(leftover, window, clusters);

  const numbered = [...leftover]
    .filter((p) => Number.isFinite(Number(posTokenId(p))))
    .sort((a, b) => Number(posTokenId(a)) - Number(posTokenId(b)));
  let ids = [];
  for (const p of numbered) {
    if (!ids.length) {
      ids = [p];
      continue;
    }
    const prev = Number(posTokenId(ids[ids.length - 1]));
    const next = Number(posTokenId(p));
    if (next === prev + 1 && ids.length < 3) {
      ids.push(p);
      continue;
    }
    takeCluster(leftover, ids, clusters);
    ids = [p];
  }
  takeCluster(leftover, ids, clusters);

  return clusters;
}

function stampCluster(cluster) {
  const ids = cluster.map(posTokenId).filter(Boolean);
  const gid = `lad:inf:${String(cluster[0].chain || "evm").toLowerCase()}:${[...ids].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))[0]}`;
  cluster.forEach((p, i) => {
    p.ladder_id = gid;
    p.ladder_token_ids = ids;
    p.ladder_primary = i === 0;
    p.strategy = "bid_ask";
  });
}

function collectLadderGroups(rows) {
  const groups = new Map();
  for (const p of rows || []) {
    const gid = p?.ladder_id ? String(p.ladder_id) : "";
    if (!gid) continue;
    if (!groups.has(gid)) {
      groups.set(gid, { chain: String(p.chain || "").toLowerCase(), ids: new Set(), meta: p });
    }
    const g = groups.get(gid);
    const one = posTokenId(p);
    if (one) g.ids.add(one);
    for (const id of parseLadderIdList(p.ladder_token_ids)) g.ids.add(id);
  }
  return groups;
}

function stampKnownLadders(positions, groups) {
  const byKey = new Map();
  for (const p of positions || []) {
    const id = posTokenId(p);
    if (id) byKey.set(`${String(p.chain || "").toLowerCase()}:${id}`, p);
  }
  for (const [gid, g] of groups) {
    const ids = [...g.ids];
    if (ids.length < 2) continue;
    for (const id of ids) {
      const p = byKey.get(`${g.chain}:${id}`);
      if (!p) continue;
      p.ladder_id = gid;
      p.ladder_token_ids = ids;
      p.strategy = "bid_ask";
    }
  }
}

export function stampInferredLadders(positions) {
  const rows = Array.isArray(positions) ? positions : [];
  const buckets = new Map();
  for (const p of rows) {
    if (completeLadderStamp(p)) continue;
    const k = ladderPlaceKey(p);
    if (!k) continue;
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(p);
  }
  for (const members of buckets.values()) {
    for (const walletGroup of splitByWallet(members)) {
      if (walletGroup.length < 2) continue;
      for (const cluster of clusterLadderMembers(walletGroup)) stampCluster(cluster);
    }
  }
  return rows;
}

function quoteIsStable(m) {
  const q = String(m?.quote_symbol || m?.pnl?.quote_symbol || "").toUpperCase();
  return /^(USDG|USDT|USDC|USD|DAI)$/.test(q);
}

function memberMarkUsd(m) {
  const pnl = m?.pnl && typeof m.pnl === "object" ? m.pnl : {};
  return firstPositive(
    m.total_value_usd,
    m.current_value_usd,
    pnl.current_value_usd,
    inventoryUsdFromSides(m),
  );
}

function memberEntryUsd(m) {
  const pnl = m?.pnl && typeof m.pnl === "object" ? m.pnl : {};
  const explicit = firstPositive(
    m.initial_value_usd,
    m.entry_value_usd,
    m.input_value,
    pnl.entry_value_usd,
    m.amount_usdg,
    quoteIsStable(m) ? pnl.entry_value_eth : null,
    quoteIsStable(m) ? m.initial_value_eth : null,
  );
  if (explicit != null) return explicit;
  return memberMarkUsd(m);
}

function sumPicked(members, pick) {
  let sum = 0;
  let any = false;
  for (const m of members) {
    const n = pick(m);
    if (n != null && Number.isFinite(n)) {
      sum += n;
      any = true;
    }
  }
  return any ? sum : null;
}

function nearUsd(a, b) {
  return Math.abs(a - b) <= Math.max(0.05, Math.max(Math.abs(a), Math.abs(b)) * 0.08);
}

/** Overlay cost next to leftover 3:2 slices — keep overlay, do not sum. */
function overlayPlusSlicesUsd(entries) {
  if (!Array.isArray(entries) || entries.length !== 3) return null;
  const s = [...entries].filter((n) => n != null && n > 0).sort((a, b) => b - a);
  if (s.length !== 3) return null;
  const [max, hi, lo] = s;
  if (!(lo > 0)) return null;
  let reconstructed = null;
  if (nearUsd(hi, lo * 1.5)) reconstructed = hi + lo + lo / 2;
  else if (nearUsd(hi, lo * 2)) reconstructed = hi + lo + hi * 1.5;
  else if (nearUsd(hi, lo * 3)) reconstructed = hi + lo + (hi * 2) / 3;
  if (reconstructed != null && nearUsd(reconstructed, max)) return max;
  return null;
}

function collapseLadderCosts(entries, mark) {
  const vals = (entries || []).filter((n) => n != null && Number(n) > 0).map(Number);
  if (!vals.length) return null;
  if (vals.length === 1) return vals[0];
  const first = vals[0];
  const same = vals.every((e) => Math.abs(e - first) <= Math.max(0.05, first * 0.02));
  if (same && mark != null && first * vals.length > mark * 1.55) return first;
  const overlay = overlayPlusSlicesUsd(vals);
  if (overlay != null) return overlay;
  return vals.reduce((a, b) => a + b, 0);
}

/** Mint clones and overlay+slice leftovers must not be added together. */
function ladderBasisUsd(members) {
  const mark = sumPicked(members, memberMarkUsd);
  return collapseLadderCosts((members || []).map(memberEntryUsd), mark);
}

function memberPnlUsd(m) {
  const pnl = m?.pnl && typeof m.pnl === "object" ? m.pnl : {};
  const direct = firstFinite(m.pnl_usd, pnl.pnl_usd);
  if (direct != null) return direct;
  const mark = memberMarkUsd(m);
  const entry = memberEntryUsd(m);
  if (mark != null && entry != null) return mark - entry;
  return null;
}

function pickExitPct(members, key) {
  for (const m of members || []) {
    const n = firstFinite(m[key], m.pnl?.[key]);
    if (n != null) return n;
  }
  return null;
}

function latestClaimAt(members) {
  let best = null;
  let bestMs = -1;
  for (const m of members || []) {
    const raw = m.fees_claimed_at ?? m.pnl?.fees_claimed_at;
    const t = Date.parse(raw);
    if (Number.isFinite(t) && t > bestMs) {
      bestMs = t;
      best = raw;
    }
  }
  return best;
}

function mergeLadderGroup(members, gid) {
  const unique = [];
  const seenMembers = new Set();
  for (const m of members || []) {
    const id = posTokenId(m);
    const key = id || `row:${unique.length}`;
    if (seenMembers.has(key)) continue;
    seenMembers.add(key);
    unique.push(m);
  }
  const sorted = unique.sort((a, b) => {
    const pa = a.ladder_primary === true ? 0 : 1;
    const pb = b.ladder_primary === true ? 0 : 1;
    if (pa !== pb) return pa - pb;
    return posTokenId(a).localeCompare(posTokenId(b), undefined, { numeric: true });
  });
  const primary = { ...sorted[0] };
  const ids = [];
  const seen = new Set();
  for (const m of sorted) {
    const id = posTokenId(m);
    if (id && !seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  primary.ladder_id = gid;
  primary.ladder_token_ids = ids;
  primary.ladder_rungs = ids.length;
  primary.strategy = "bid_ask";
  primary.tokenId = ids[0];
  primary.position = ids[0];
  const lowers = sorted.map((m) => Number(m.tick_lower ?? m.pnl?.tick_lower)).filter(Number.isFinite);
  const uppers = sorted.map((m) => Number(m.tick_upper ?? m.pnl?.tick_upper)).filter(Number.isFinite);
  if (lowers.length) primary.tick_lower = Math.min(...lowers);
  if (uppers.length) primary.tick_upper = Math.max(...uppers);

  const mark = sumPicked(sorted, memberMarkUsd);
  let basis = ladderBasisUsd(sorted);
  const wild = sorted.some((m) => {
    const pct = firstFinite(m.pnl_pct, m.pnl?.pnl_pct);
    return pct != null && Math.abs(pct) > 200;
  });
  let pnlUsd = wild && mark != null && basis != null && basis > 0
    ? mark - basis
    : sumPicked(sorted, memberPnlUsd);
  if (pnlUsd == null && mark != null && basis != null) pnlUsd = mark - basis;
  const fromMark = mark != null && basis != null && basis > 0 ? mark - basis : null;
  if (fromMark != null && (
    wild
    || pnlUsd == null
    || Math.abs(pnlUsd - fromMark) > Math.max(5, Math.abs(fromMark) * 0.5)
  )) {
    pnlUsd = fromMark;
  }
  if (mark != null) {
    primary.total_value_usd = mark;
    primary.current_value_usd = mark;
  }
  const quoteUsd = sumPicked(sorted, (m) => firstPositive(
    m.amount_eth_usd,
    m.pnl?.amount_eth_usd,
    m.amount_quote_usd,
    m.pnl?.amount_quote_usd,
  ));
  const memeUsd = sumPicked(sorted, (m) => firstPositive(m.amount_meme_usd, m.pnl?.amount_meme_usd));
  if (quoteUsd != null) {
    primary.amount_eth_usd = quoteUsd;
    primary.amount_quote_usd = quoteUsd;
  }
  if (memeUsd != null) primary.amount_meme_usd = memeUsd;
  if (basis != null) {
    primary.initial_value_usd = basis;
    primary.entry_value_usd = basis;
    primary.input_value = basis;
  }
  if (pnlUsd != null) primary.pnl_usd = pnlUsd;
  const sl = pickExitPct(sorted, "stop_loss_pct");
  const tp = pickExitPct(sorted, "take_profit_pct");
  if (sl != null) primary.stop_loss_pct = sl;
  if (tp != null) primary.take_profit_pct = tp;
  const claimedAt = latestClaimAt(sorted);
  if (claimedAt) primary.fees_claimed_at = claimedAt;

  const unclaimedUsd = sumPicked(sorted, (m) => firstPositive(
    m.unclaimed_fee_usd,
    m.unclaimed_fees_usd,
    m.pnl?.unclaimed_fee_usd,
  ));
  const unclaimedQuote = sumPicked(sorted, (m) => firstPositive(
    m.unclaimed_fees_quote,
    m.pnl?.unclaimed_fees_quote,
  ));
  const unclaimed = unclaimedUsd ?? unclaimedQuote;
  const claimed = sumPicked(sorted, (m) => firstPositive(
    m.fees_claimed_usd,
    m.pnl?.fees_claimed_usd,
    m.collected_fees_usd,
    m.pnl?.collected_fees_usd,
  ));
  const pnlObj = primary.pnl && typeof primary.pnl === "object" ? { ...primary.pnl } : {};
  if (mark != null) pnlObj.current_value_usd = mark;
  if (basis != null) pnlObj.entry_value_usd = basis;
  if (quoteUsd != null) pnlObj.amount_eth_usd = quoteUsd;
  if (memeUsd != null) pnlObj.amount_meme_usd = memeUsd;
  if (unclaimed != null) {
    primary.unclaimed_fee_usd = unclaimed;
    pnlObj.unclaimed_fee_usd = unclaimed;
  }
  if (unclaimedQuote != null) {
    primary.unclaimed_fees_quote = unclaimedQuote;
    pnlObj.unclaimed_fees_quote = unclaimedQuote;
  }
  if (claimed != null) {
    primary.fees_claimed_usd = claimed;
    primary.collected_fees_usd = claimed;
    pnlObj.fees_claimed_usd = claimed;
    pnlObj.collected_fees_usd = claimed;
  }
  if (claimedAt) pnlObj.fees_claimed_at = claimedAt;
  pnlObj.strategy = "bid_ask";
  if (pnlUsd != null) pnlObj.pnl_usd = pnlUsd;
  if (basis != null && basis > 0 && pnlUsd != null) {
    primary.pnl_pct = (pnlUsd / basis) * 100;
    pnlObj.pnl_pct = primary.pnl_pct;
    pnlObj.onchain_pnl_pct = primary.pnl_pct;
  }
  primary.pnl = pnlObj;
  primary.in_range = sorted.some((m) => m.in_range === true || m.pnl?.in_range === true);
  return primary;
}

/** Hide raw rungs once a collapsed Bid-Ask card already includes them. */
export function dropCoveredLadderSiblings(positions) {
  const rows = Array.isArray(positions) ? positions : [];
  const covered = new Set();
  for (const p of rows) {
    if (!(Number(p?.ladder_rungs) > 1)) continue;
    const ids = parseLadderIdList(p.ladder_token_ids);
    if (ids.length < 2) continue;
    const primary = posTokenId(p);
    const chain = String(p.chain || "").toLowerCase();
    for (const id of ids) {
      if (String(id) === primary) continue;
      covered.add(`${chain}:${id}`);
    }
  }
  if (!covered.size) return rows;
  return rows.filter((p) => {
    if (Number(p?.ladder_rungs) > 1) return true;
    const id = posTokenId(p);
    const chain = String(p.chain || "").toLowerCase();
    return !covered.has(`${chain}:${id}`);
  });
}

export function collapseLadderPositions(positions) {
  const rows = Array.isArray(positions) ? positions : [];
  const groups = new Map();
  for (const p of rows) {
    const gid = p?.ladder_id ? String(p.ladder_id) : "";
    if (!gid) continue;
    if (!groups.has(gid)) groups.set(gid, []);
    groups.get(gid).push(p);
  }
  const merged = new Map();
  for (const [gid, members] of groups) {
    merged.set(gid, members.length === 1 ? { ...members[0] } : mergeLadderGroup(members, gid));
  }
  const out = [];
  const emitted = new Set();
  for (const p of rows) {
    const gid = p?.ladder_id ? String(p.ladder_id) : "";
    if (!gid) {
      out.push(p);
      continue;
    }
    if (emitted.has(gid)) continue;
    emitted.add(gid);
    out.push(merged.get(gid));
  }
  return out;
}

function dedupeOpenRows(rows) {
  const seen = new Set();
  const out = [];
  for (const p of rows) {
    const chain = String(p?.chain || "").toLowerCase();
    const id = posTokenId(p);
    const key = id ? `${chain}:${id}` : `row:${out.length}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

/** One Open row per Bid-Ask ladder; Spot LPs stay as-is. */
export function collapseOpenLadders(positions) {
  const rows = dedupeOpenRows((Array.isArray(positions) ? positions : []).map((p) => ({ ...p })));
  stampKnownLadders(rows, collectLadderGroups(rows));
  stampInferredLadders(rows);
  stampKnownLadders(rows, collectLadderGroups(rows));
  return collapseLadderPositions(dropCoveredLadderSiblings(rows));
}

export function isBidAskCard(p) {
  const s = String(p?.strategy || p?.pnl?.strategy || "").toLowerCase().replace(/-/g, "_");
  return s === "bid_ask" || parseLadderIdList(p?.ladder_token_ids).length > 1;
}
