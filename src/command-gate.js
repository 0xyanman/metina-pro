/**
 * Telegram anti-spam. Stops a chat from queuing dozens of /open + /close
 * onto Metina Pro (lookup/deploy/close are heavy).
 */

export function createCommandGate({
  minIntervalMs = 2_000,
  openCooldownMs = 45_000,
  closeCooldownMs = 10_000,
  now = () => Date.now(),
} = {}) {
  const last = { any: 0, "/open": 0, "/close": 0 };

  function waitMs(cmd) {
    const t = now();
    const waits = [];
    if (last.any) waits.push(last.any + minIntervalMs - t);
    if (cmd === "/open" && last["/open"]) waits.push(last["/open"] + openCooldownMs - t);
    if (cmd === "/close" && last["/close"]) waits.push(last["/close"] + closeCooldownMs - t);
    if (!waits.length) return 0;
    return Math.max(0, ...waits);
  }

  return {
    check(cmd) {
      const wait = waitMs(cmd);
      if (wait > 0) {
        return {
          ok: false,
          waitSec: Math.max(1, Math.ceil(wait / 1000)),
          cmd,
        };
      }
      return { ok: true };
    },
    mark(cmd) {
      const t = now();
      last.any = t;
      if (cmd === "/open" || cmd === "/close") last[cmd] = t;
    },
  };
}

export function formatCooldownMessage(hit) {
  const cmd = hit?.cmd || "/command";
  const sec = hit?.waitSec || 1;
  return `⚠️ Terlalu cepat. Tunggu <b>${sec}s</b> sebelum ${cmd} lagi (anti-spam).`;
}
