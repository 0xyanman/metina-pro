/** How many poll ticks fit in an interval (at least 1). */
export function ticksForInterval(intervalMs, pollMs) {
  const poll = Math.max(1, Number(pollMs) || 45_000);
  const interval = Number(intervalMs);
  if (!(Number.isFinite(interval) && interval > 0)) return 1;
  return Math.max(1, Math.round(interval / poll));
}

/**
 * Regular ticks stay lite (indexer only). Hydrate/discover stay on first tick,
 * after /open, and on their slower cadence so SL/TP still sees a fresh book.
 */
export function shouldFetchOpenInventory(tick, {
  discoverEvery = 27,
  hydrateEvery = 4,
  pendingFullSync = false,
} = {}) {
  const n = Number(tick) || 0;
  if (pendingFullSync || n <= 1) return { discover: true, hydrate: true };
  const discover = discoverEvery > 0 && n % discoverEvery === 0;
  const hydrate = discover || (hydrateEvery > 0 && n % hydrateEvery === 0);
  return { discover, hydrate };
}
