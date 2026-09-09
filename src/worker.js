import { closePayload, evaluateExit, livePnlPct, positionKey, watchLine } from "./evaluate-exit.js";
import {
  createPositionTracker,
  formatCloseMessage,
  formatOpenSummary,
  formatHelpMessage,
  sortOpenPositions,
} from "./position-notify.js";
import {
  parseOpenCommand,
  pickOpenPool,
  buildDeployPayload,
  lookupBody,
  formatOpenUsage,
  formatOpenMessage,
} from "./open-position.js";
import { createCommandGate, formatCooldownMessage } from "./command-gate.js";
import { escapeHtml } from "./telegram.js";

function now() {
  return new Date().toISOString();
}

function log(msg) {
  console.log(`[${now()}] ${msg}`);
}

async function getOpenPositions(client, discover = false) {
  const data = await client.positions({ discover });
  const list = Array.isArray(data?.positions) ? data.positions : [];
  return list.filter((p) => !p.closed_on_chain && !p.readonly);
}

async function handleHelpCommand(notifier) {
  await notifier?.send(formatHelpMessage());
}

async function handleRefreshCommand(client, notifier, commandGate) {
  commandGate?.mark("/refresh");
  await notifier?.send("⏳ Mengambil data posisi terbaru...");
  const open = await getOpenPositions(client, true);
  if (open.length === 0) {
    await notifier?.send("📂 Tidak ada posisi open saat ini.");
    return;
  }
  const summary = formatOpenSummary(open);
  await notifier?.send(summary);
}

async function closePosition(client, notifier, tracker, inflight, pos, { reason, closeReason, notifyStart = false }) {
  const key = positionKey(pos);
  if (inflight.has(key)) {
    await notifier?.send(`⚠️ Posisi ${escapeHtml(pos.pair || pos.position)} sedang dalam proses closing.`);
    return;
  }

  inflight.add(key);
  if (notifyStart) {
    const posIdLabel = pos.position || pos.tokenId || "";
    await notifier?.send(
      `⏳ Memproses penutupan posisi <b>${escapeHtml(pos.pair || pos.position)}</b> (ID: <code>${escapeHtml(posIdLabel)}</code>)...`
    );
  }

  try {
    const result = await client.close(
      closePayload(pos, {
        swap: true,
        kind: "manual",
        close_reason: closeReason,
      })
    );
    const ok = result?.success || result?.ok;
    if (ok && tracker) tracker.markWorkerClosed(key);
    await notifier?.send(
      formatCloseMessage({
        position: pos,
        kind: "manual",
        reason,
        tx: ok ? result.tx || result.txs?.[0] || "" : null,
        error: !ok ? result.error || result.message || "unknown" : null,
        dry: false,
      })
    );
    if (!ok) inflight.delete(key);
  } catch (err) {
    inflight.delete(key);
    await notifier?.send(
      formatCloseMessage({
        position: pos,
        kind: "manual",
        reason,
        error: err.message,
        dry: false,
      })
    );
  }
}

async function handleCloseAll(client, notifier, tracker, inflight, open) {
  await notifier?.send(`⏳ Memproses penutupan <b>${open.length} posisi open</b>...`);
  for (const p of open) {
    await closePosition(client, notifier, tracker, inflight, p, {
      reason: "Command /close all",
      closeReason: "telegram_command_all",
      notifyStart: false,
    });
  }
}

async function handleCloseProfit(client, notifier, tracker, inflight) {
  const open = await getOpenPositions(client, true);
  if (open.length === 0) {
    await notifier?.send("⚠️ Tidak ada posisi open yang bisa ditutup.");
    return;
  }

  const profitPositions = open.filter((p) => {
    const pct = livePnlPct(p);
    if (pct != null) return pct > 0;
    const usd = Number(p?.pnl?.pnl_usd ?? p?.pnl_usd);
    return Number.isFinite(usd) && usd > 0;
  });

  if (profitPositions.length === 0) {
    await notifier?.send("📂 Tidak ada posisi open yang sedang profit saat ini.");
    return;
  }

  await notifier?.send(`⏳ Memproses penutupan <b>${profitPositions.length} posisi profit</b>...`);
  for (const p of profitPositions) {
    await closePosition(client, notifier, tracker, inflight, p, {
      reason: "Command /close profit",
      closeReason: "telegram_command_profit",
      notifyStart: false,
    });
  }
}

async function handleCloseSpecific(client, notifier, tracker, inflight, open, target) {
  const sorted = sortOpenPositions(open);
  const pos = sorted.find((p, idx) => {
    const pId = String(p.position || p.tokenId || "").toLowerCase();
    return pId === target || String(idx + 1) === target;
  });

  if (!pos) {
    await notifier?.send(`⚠️ Posisi dengan ID/Nomor <code>${escapeHtml(target)}</code> tidak ditemukan dalam open list.`);
    return;
  }

  await closePosition(client, notifier, tracker, inflight, pos, {
    reason: `Command /close ${target}`,
    closeReason: `telegram_command_${target}`,
    notifyStart: true,
  });
}

async function handleCloseCommand(parsed, { client, notifier, tracker, inflight, liveClose, commandGate }) {
  const rawTarget = parsed.args[0];
  if (!rawTarget) {
    await notifier?.send(
      "⚠️ /close butuh target. Pakai <code>/close all</code>, <code>/close profit</code>, atau <code>/close &lt;id atau nomor&gt;</code>."
    );
    return;
  }

  commandGate?.mark("/close");

  if (!liveClose) {
    await notifier?.send(
      "⚠️ LIVE_CLOSE=0 — command /close diabaikan. Set LIVE_CLOSE=1 di .env untuk menutup posisi dari Telegram."
    );
    return;
  }

  const target = String(rawTarget).trim().toLowerCase();

  if (target === "profit" || target === "untung" || target === "tp") {
    await handleCloseProfit(client, notifier, tracker, inflight);
    return;
  }

  const open = await getOpenPositions(client, true);

  if (open.length === 0) {
    await notifier?.send("⚠️ Tidak ada posisi open yang bisa ditutup.");
    return;
  }

  if (target === "all" || target === "*") {
    await handleCloseAll(client, notifier, tracker, inflight, open);
  } else {
    await handleCloseSpecific(client, notifier, tracker, inflight, open, target);
  }
}

export async function handleTelegramCommand(parsed, context) {
  const { cmd } = parsed;
  const gate = context.commandGate;

  if (cmd === "/help" || cmd === "/start") {
    await handleHelpCommand(context.notifier);
    return;
  }

  if (gate && (cmd === "/refresh" || cmd === "/close" || cmd === "/open")) {
    const hit = gate.check(cmd);
    if (!hit.ok) {
      await context.notifier?.send(formatCooldownMessage(hit));
      return;
    }
  }

  if (cmd === "/refresh") {
    await handleRefreshCommand(context.client, context.notifier, gate);
    return;
  }

  if (cmd === "/close") {
    await handleCloseCommand(parsed, context);
    return;
  }

  if (cmd === "/open") {
    await handleOpenCommand(parsed, context);
  }
}

async function handleOpenCommand(parsed, { client, notifier, inflight, liveOpen, commandGate }) {
  const spec = parseOpenCommand(parsed.args);
  if (spec.error) {
    await notifier?.send(formatOpenUsage());
    return;
  }

  const openKey = `open:${spec.chain}:${spec.token}`;
  if (inflight?.has("open:busy") || inflight?.has(openKey)) {
    await notifier?.send("⚠️ Open posisi masih diproses. Tunggu selesai dulu.");
    return;
  }

  commandGate?.mark("/open");
  inflight?.add("open:busy");
  inflight?.add(openKey);
  try {
    await notifier?.send(
      `⏳ Lookup pool untuk <code>${escapeHtml(spec.token)}</code>${spec.chain !== "auto" ? ` · ${escapeHtml(spec.chain)}` : ""}...`
    );
    const lookup = await client.lookup(lookupBody(spec));
    const pool = pickOpenPool(lookup, spec);
    if (!pool) {
      await notifier?.send(
        "⚠️ Tidak ada pool Uniswap yang bisa di-open. Coba chain lain, atau paste alamat token 0x."
      );
      return;
    }

    const payload = buildDeployPayload(lookup, pool, spec);
    if (!liveOpen) {
      await notifier?.send(formatOpenMessage({ lookup, pool, payload, dry: true }));
      return;
    }

    const pair = pool.name || payload.pair || spec.token;
    await notifier?.send(`⏳ Membuka <b>${escapeHtml(pair)}</b> via Metina Pro...`);
    const result = await client.deploy(payload);
    const ok = result?.success || result?.ok;
    const dryRun = result?.dry_run || result?.dryRun;
    if (!ok && !dryRun) {
      await notifier?.send(
        formatOpenMessage({
          lookup,
          pool,
          payload,
          error: result?.error || result?.message || "unknown",
        })
      );
      return;
    }
    if (dryRun && !ok) {
      await notifier?.send(
        formatOpenMessage({
          lookup,
          pool,
          payload,
          error: result?.message || "Metina Pro DRY_RUN — deploy not executed",
        })
      );
      return;
    }
    await notifier?.send(formatOpenMessage({ lookup, pool, payload, result }));
  } catch (err) {
    await notifier?.send(
      formatOpenMessage({
        payload: { pair: spec.token, chain: spec.chain },
        error: err.message,
      })
    );
  } finally {
    inflight?.delete(openKey);
    inflight?.delete("open:busy");
  }
}

export async function runCycle(client, { liveClose, discover }, inflight, options = {}) {
  const { notifier, tracker } = options;
  const open = await getOpenPositions(client, discover);
  let hits = 0;
  const dryHits = new Set();

  for (const p of open) {
    log(watchLine(p));
    const decision = evaluateExit(p);
    if (decision.action !== "close") continue;
    hits += 1;
    const key = positionKey(p);
    const label = `${p.pair || p.position} ${decision.kind} (${decision.reason})`;
    if (inflight.has(key)) {
      log(`skip in-flight ${label}`);
      continue;
    }
    if (!liveClose) {
      log(`DRY ${label}`);
      dryHits.add(key);
      const firstDry = !tracker || tracker.markDryNotified(key);
      if (firstDry && notifier?.isEnabled()) {
        const msg = formatCloseMessage({
          position: p,
          kind: decision.kind,
          reason: decision.reason,
          dry: true,
        });
        await notifier.send(msg);
      }
      continue;
    }
    inflight.add(key);
    log(`closing ${label}`);
    try {
      const result = await client.close(closePayload(p, {
        swap: true,
        kind: decision.kind,
        close_reason: decision.reason,
      }));
      const ok = result.success || result.ok;
      log(
        ok
          ? `closed ${p.pair || p.position} tx=${result.tx || result.txs?.[0] || "ok"}`
          : `close failed ${p.pair || p.position}: ${result.error || result.message || "unknown"}`,
      );
      if (tracker) tracker.markWorkerClosed(key);
      if (notifier?.isEnabled()) {
        const msg = formatCloseMessage({
          position: p,
          kind: decision.kind,
          reason: decision.reason,
          tx: ok ? (result.tx || result.txs?.[0] || "") : null,
          error: !ok ? (result.error || result.message || "unknown") : null,
          dry: false,
        });
        await notifier.send(msg);
      }
      if (!ok) inflight.delete(key);
    } catch (err) {
      inflight.delete(key);
      log(`close error ${p.pair || p.position}: ${err.message}`);
      if (notifier?.isEnabled()) {
        const msg = formatCloseMessage({
          position: p,
          kind: decision.kind,
          reason: decision.reason,
          error: err.message,
          dry: false,
        });
        await notifier.send(msg);
      }
    }
  }

  if (tracker?.pruneDryNotified) {
    tracker.pruneDryNotified(dryHits);
  }

  if (tracker) {
    await tracker.notifyCycle({ open, discover, notifier });
  }

  return { count: open.length, hits };
}

export async function startWorker(cfg, client, options = {}) {
  const { notifier, tracker = createPositionTracker() } = options;
  await client.login();
  log(`logged in as ${cfg.email} wallet ${cfg.address}`);
  log(
    cfg.liveClose
      ? "LIVE_CLOSE=1 — will close when SL/TP hits"
      : "LIVE_CLOSE=0 — watch only. Set LIVE_CLOSE=1 in .env to close.",
  );
  log(
    cfg.liveOpen
      ? "LIVE_OPEN=1 — Telegram /open will mint via Metina Pro"
      : "LIVE_OPEN=0 — /open lookup only. Set LIVE_OPEN=1 in .env to mint.",
  );
  if (notifier?.isEnabled()) {
    log("Telegram notifications enabled");
  }

  const inflight = new Set();
  const commandGate = createCommandGate({
    minIntervalMs: cfg.telegramCmdIntervalMs,
    openCooldownMs: cfg.telegramOpenCooldownMs,
    closeCooldownMs: cfg.telegramCloseCooldownMs,
  });
  let tick = 0;
  let busy = false;

  if (notifier?.isEnabled() && typeof notifier.startCommandPoller === "function") {
    notifier.startCommandPoller(async (parsed) => {
      try {
        await handleTelegramCommand(parsed, {
          client,
          notifier,
          tracker,
          inflight,
          liveClose: cfg.liveClose,
          liveOpen: cfg.liveOpen,
          commandGate,
        });
      } catch (err) {
        log(`telegram command error: ${err.message}`);
      }
    });
    log(
      `Telegram command listener started (/refresh, /close, /open, /help) · open cooldown ${Math.round(cfg.telegramOpenCooldownMs / 1000)}s`,
    );
  }

  const once = async () => {
    if (busy) {
      log("skip overlap — previous cycle still running");
      return;
    }
    busy = true;
    tick += 1;
    const discover = tick === 1 || tick % cfg.discoverEvery === 0;
    try {
      const { count, hits } = await runCycle(
        client,
        { liveClose: cfg.liveClose, discover },
        inflight,
        { notifier, tracker },
      );
      log(`watch ${count} open · hits ${hits}${discover ? " · discover" : ""}`);
    } catch (err) {
      log(`cycle failed: ${err.message}`);
    } finally {
      busy = false;
    }
  };

  await once();
  return setInterval(once, cfg.pollMs);
}


