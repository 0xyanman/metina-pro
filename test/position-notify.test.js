import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  escapeHtml,
  createTelegramNotifier,
  parseTelegramCommand,
} from "../src/telegram.js";
import {
  formatTimestampWIB,
  formatNumber,
  formatUsd,
  formatPct,
  formatPriceRange,
  formatPnlBlock,
  formatCompactNumber,
  formatAssetsBlock,
  formatAllPnlSummary,
  formatOpenSummary,
  formatCloseMessage,
  formatHelpMessage,
  createPositionTracker,
} from "../src/position-notify.js";

describe("Telegram client", () => {
  test("parseTelegramCommand parses commands and arguments", () => {
    assert.deepEqual(parseTelegramCommand("/refresh"), { cmd: "/refresh", args: [], raw: "/refresh" });
    assert.deepEqual(parseTelegramCommand("/refresh@MyBot"), { cmd: "/refresh", args: [], raw: "/refresh@MyBot" });
    assert.deepEqual(parseTelegramCommand("/close 933596"), { cmd: "/close", args: ["933596"], raw: "/close 933596" });
    assert.deepEqual(parseTelegramCommand("/close all"), { cmd: "/close", args: ["all"], raw: "/close all" });
    assert.equal(parseTelegramCommand("not a command"), null);
  });
  test("escapeHtml escapes special characters", () => {
    assert.equal(escapeHtml("A & B < C > D \"E\""), "A &amp; B &lt; C &gt; D &quot;E&quot;");
    assert.equal(escapeHtml(null), "");
    assert.equal(escapeHtml(123), "123");
  });

  test("skips sending if not configured or disabled", async () => {
    let fetchCalled = false;
    const notifier = createTelegramNotifier({
      token: "",
      chatId: "",
      enabled: false,
      fetchFn: async () => {
        fetchCalled = true;
        return { ok: true, json: async () => ({ ok: true }) };
      },
    });

    assert.equal(notifier.isEnabled(), false);
    const res = await notifier.send("test");
    assert.equal(res.skipped, true);
    assert.equal(fetchCalled, false);
  });

  test("sends message with HTML parse_mode and message_thread_id", async () => {
    let capturedUrl = "";
    let capturedBody = null;

    const notifier = createTelegramNotifier({
      token: "123:ABC",
      chatId: "-10012345",
      threadId: 99,
      enabled: true,
      fetchFn: async (url, options) => {
        capturedUrl = url;
        capturedBody = JSON.parse(options.body);
        return {
          ok: true,
          json: async () => ({ ok: true, result: { message_id: 1 } }),
        };
      },
    });

    assert.equal(notifier.isEnabled(), true);
    const res = await notifier.send("<b>Hello</b>");
    assert.equal(res.ok, true);
    assert.equal(capturedUrl, "https://api.telegram.org/bot123:ABC/sendMessage");
    assert.equal(capturedBody.chat_id, "-10012345");
    assert.equal(capturedBody.message_thread_id, 99);
    assert.equal(capturedBody.parse_mode, "HTML");
    assert.equal(capturedBody.text, "<b>Hello</b>");
  });

  test("handles Telegram API errors gracefully without throwing", async () => {
    const notifier = createTelegramNotifier({
      token: "123:ABC",
      chatId: "-10012345",
      enabled: true,
      fetchFn: async () => ({
        ok: false,
        status: 400,
        json: async () => ({ ok: false, description: "Bad Request: chat not found" }),
      }),
    });

    const res = await notifier.send("test");
    assert.equal(res.ok, false);
    assert.equal(res.error, "Bad Request: chat not found");
  });

  test("handles network exception gracefully without throwing", async () => {
    const notifier = createTelegramNotifier({
      token: "123:ABC",
      chatId: "-10012345",
      enabled: true,
      fetchFn: async () => {
        throw new Error("ETIMEDOUT");
      },
    });

    const res = await notifier.send("test");
    assert.equal(res.ok, false);
    assert.equal(res.error, "ETIMEDOUT");
  });
});

describe("position-notify formatting", () => {
  test("formatTimestampWIB formats date in UTC+7", () => {
    const d = new Date("2026-08-26T02:15:00.000Z"); // 02:15 UTC = 09:15 WIB
    const formatted = formatTimestampWIB(d);
    assert.match(formatted, /26 Aug 2026, 09:15 WIB/);
  });

  test("formatNumber, formatUsd, and formatPct", () => {
    assert.equal(formatNumber(0.002066), "0.002066");
    assert.equal(formatNumber(12.346), "12.346");
    assert.equal(formatNumber(null), "");

    assert.equal(formatUsd(2.37), "$2.37");
    assert.equal(formatUsd(2.37, true), "+$2.37");
    assert.equal(formatUsd(-1.06), "-$1.06");
    assert.equal(formatUsd(0), "$0.00");

    assert.equal(formatPct(10.49), "+10.49%");
    assert.equal(formatPct(-3.54), "-3.54%");
    assert.equal(formatPct(0), "0.00%");
  });

  test("formatPriceRange generates ASCII range bar", () => {
    const inRangePos = {
      price_min: 0.002,
      price_now: 0.003,
      price_max: 0.012,
      tick_lower: 319968,
      tick_upper: 338148,
    };
    const out = formatPriceRange(inRangePos);
    assert.match(out, /Range: MIN 0.002 · NOW 0.003 · MAX 0.012/);
    assert.match(out, /tick 319968 → 338148/);
    assert.match(out, /\[=.*●.*=\]/);

    const belowRangePos = {
      price_min: 0.002,
      price_now: 0.001,
      price_max: 0.012,
    };
    const belowOut = formatPriceRange(belowRangePos);
    assert.match(belowOut, /\[●·······················\]/);

    const aboveRangePos = {
      price_min: 0.002,
      price_now: 0.020,
      price_max: 0.012,
    };
    const aboveOut = formatPriceRange(aboveRangePos);
    assert.match(aboveOut, /\[·······················●\]/);
  });

  test("formatPnlBlock formats all available PNL fields", () => {
    const pos = {
      pnl: {
        pnl_pct: -3.54,
        pnl_usd: -1.06,
        onchain_pnl_pct: -13.38,
        current_value_usd: 29.81,
        unclaimed_fee_usd: 0.0,
        fees_claimed_usd: 2.37,
      },
    };
    const block = formatPnlBlock(pos);
    assert.match(block, /PNL:/);
    assert.match(block, /Live:\s+-3\.54%\s+\(-\$1\.06\)/);
    assert.match(block, /On-chain:\s+-13\.38%/);
    assert.match(block, /Value:\s+\$29\.81/);
    assert.match(block, /Unclaimed fees:\s+\$0\.00/);
    assert.match(block, /Collected fees:\s+\$2\.37/);
  });

  test("formatAssetsBlock formats token assets breakdown", () => {
    assert.equal(formatCompactNumber(1870), "1.87k");
    assert.equal(formatCompactNumber(2500000), "2.5M");
    assert.equal(formatCompactNumber(28.37), "28.37");

    const pos = {
      pair: "PONSBOT/USDG",
      pnl: {
        amount_meme: 1870,
        amount_meme_usd: 1.58,
        meme_symbol: "PONSBOT",
        amount_eth: 28.37,
        amount_eth_usd: 28.37,
        quote_symbol: "USDG",
      },
    };
    const block = formatAssetsBlock(pos);
    assert.match(block, /Assets:/);
    assert.match(block, /1\.87k PONSBOT \(\$1\.58\)/);
    assert.match(block, /\$28\.37/);

    assert.doesNotThrow(() => formatAssetsBlock({ pair: "SOLOTOKEN", pnl: { amount_meme: 1 } }));
  });

  test("formatAllPnlSummary aggregates total USD and average Live %", () => {
    const positions = [
      { pnl: { pnl_usd: 1.5, pnl_pct: 2.0 } },
      { pnl: { pnl_usd: 2.5, pnl_pct: 4.0 } },
    ];
    const summary = formatAllPnlSummary(positions);
    assert.equal(summary, "All PNL: +$4.00 · Live avg +3.00%");

    const single = [{ pnl: { pnl_usd: -1.06, pnl_pct: -3.54 } }];
    const singleSummary = formatAllPnlSummary(single);
    assert.equal(singleSummary, "All PNL: -$1.06 · Live -3.54%");
  });

  test("formatOpenSummary produces structured HTML multi-position message", () => {
    const positions = [
      {
        position: "933596",
        pair: "MARTIANS/USDG",
        chain: "robinhood",
        version: "v4",
        agent: true,
        stop_loss_pct: -50,
        take_profit_pct: 10,
        pnl: {
          pnl_pct: -3.54,
          pnl_usd: -1.06,
          onchain_pnl_pct: -13.38,
          current_value_usd: 29.81,
        },
      },
      {
        position: "933597",
        pair: "HOOD10/USDG",
        chain: "robinhood",
        version: "v4",
        stop_loss_pct: -50,
        take_profit_pct: 10,
        pnl: {
          pnl_pct: 2.15,
          pnl_usd: 0.97,
          onchain_pnl_pct: 2.08,
          current_value_usd: 45.2,
        },
      },
    ];

    const msg = formatOpenSummary(positions);
    assert.match(msg, /📂 <b>Open Positions · 2 active<\/b>/);
    assert.match(msg, /All PNL:/);
    // Should sort alphabetically: HOOD10 comes before MARTIANS, and include ID
    assert.match(msg, /<b>① HOOD10\/USDG<\/b> · ID: <code>933597<\/code>[\s\S]*<b>② MARTIANS\/USDG<\/b> · ID: <code>933596<\/code>/);
    assert.match(msg, /────────/);
  });

  test("formatHelpMessage produces command instructions", () => {
    const help = formatHelpMessage();
    assert.match(help, /Metina TPSL Bot Commands/);
    assert.match(help, /\/refresh/);
    assert.match(help, /\/open/);
    assert.match(help, /\/close/);
  });


  test("formatCloseMessage formats different trigger types", () => {
    const pos = {
      pair: "MARTIANS/USDG",
      chain: "robinhood",
      stop_loss_pct: -50,
      take_profit_pct: 10,
      pnl: { pnl_pct: 10.49, pnl_usd: 2.98, current_value_usd: 29.81 },
    };

    // 1. Success
    const successMsg = formatCloseMessage({
      position: pos,
      kind: "take_profit",
      tx: "0x06a48dead",
    });
    assert.match(successMsg, /🔴 <b>Position Closed<\/b>/);
    assert.match(successMsg, /Trigger: Take Profit/);
    assert.match(successMsg, /Tx: <code>0x06a48dead<\/code>/);

    // 2. Failed
    const failMsg = formatCloseMessage({
      position: pos,
      kind: "stop_loss",
      error: "rpc down",
    });
    assert.match(failMsg, /⚠️ <b>Close Failed<\/b>/);
    assert.match(failMsg, /Trigger: Stop Loss/);
    assert.match(failMsg, /Reason: rpc down/);

    // 3. DRY
    const dryMsg = formatCloseMessage({
      position: pos,
      kind: "take_profit",
      dry: true,
    });
    assert.match(dryMsg, /🧪 <b>\[DRY\] Would Close<\/b>/);
    assert.match(dryMsg, /Trigger: Take Profit/);
    assert.match(dryMsg, /threshold TP 10%/);

    // 4. External / manual
    const extMsg = formatCloseMessage({
      position: pos,
      reason: "manual_or_external",
    });
    assert.match(extMsg, /🔴 <b>Position Closed<\/b>/);
    assert.match(extMsg, /Trigger: Manual \/ external/);
    assert.match(extMsg, /PNL \(last seen\):/);
  });
});

describe("PositionTracker cycle integration", () => {
  test("skips Telegram when open is empty", async () => {
    let sentCount = 0;
    const notifier = {
      isEnabled: () => true,
      send: async () => {
        sentCount += 1;
        return { ok: true };
      },
    };

    const tracker = createPositionTracker();
    await tracker.notifyCycle({ open: [], discover: true, notifier });
    assert.equal(sentCount, 0);
  });

  test("sends open summary during discover tick when positions exist", async () => {
    const sentMessages = [];
    const notifier = {
      isEnabled: () => true,
      send: async (msg) => {
        sentMessages.push(msg);
        return { ok: true };
      },
    };

    const tracker = createPositionTracker();
    const open = [
      {
        poolType: "uniswap",
        chain: "robinhood",
        position: "1",
        pair: "TEST/USDG",
        pnl: { pnl_pct: 1.0 },
      },
    ];

    // Non-discover cycle: does not send summary
    await tracker.notifyCycle({ open, discover: false, notifier });
    assert.equal(sentMessages.length, 0);

    // Discover cycle: sends summary
    await tracker.notifyCycle({ open, discover: true, notifier });
    assert.equal(sentMessages.length, 1);
    assert.match(sentMessages[0], /Open Positions · 1 active/);
  });

  test("detects external close when position is removed in subsequent cycle", async () => {
    const sentMessages = [];
    const notifier = {
      isEnabled: () => true,
      send: async (msg) => {
        sentMessages.push(msg);
        return { ok: true };
      },
    };

    const tracker = createPositionTracker();
    const pos1 = {
      poolType: "uniswap",
      chain: "robinhood",
      position: "1",
      pair: "POS1/USDG",
      pnl: { pnl_pct: 1.0 },
    };
    const pos2 = {
      poolType: "uniswap",
      chain: "robinhood",
      position: "2",
      pair: "POS2/USDG",
      pnl: { pnl_pct: 2.0 },
    };

    // Cycle 1: 2 positions open
    await tracker.notifyCycle({ open: [pos1, pos2], discover: false, notifier });
    assert.equal(sentMessages.length, 0);

    // Cycle 2: pos1 is removed externally
    await tracker.notifyCycle({ open: [pos2], discover: false, notifier });
    assert.equal(sentMessages.length, 1);
    assert.match(sentMessages[0], /Position Closed/);
    assert.match(sentMessages[0], /POS1\/USDG/);
    assert.match(sentMessages[0], /Manual \/ external/);
  });

  test("does not send duplicate external close if worker marked it closed", async () => {
    const sentMessages = [];
    const notifier = {
      isEnabled: () => true,
      send: async (msg) => {
        sentMessages.push(msg);
        return { ok: true };
      },
    };

    const tracker = createPositionTracker();
    const pos1 = {
      poolType: "uniswap",
      chain: "bsc",
      position: "10",
      pair: "BNB/USDT",
    };

    // Cycle 1
    await tracker.notifyCycle({ open: [pos1], discover: false, notifier });

    // Worker closes pos1
    tracker.markWorkerClosed("uniswap-bsc-10");

    // Cycle 2: pos1 is now gone from open
    await tracker.notifyCycle({ open: [], discover: false, notifier });
    assert.equal(sentMessages.length, 0);
  });

  test("markDryNotified only returns true once until pruned", () => {
    const tracker = createPositionTracker();
    assert.equal(tracker.markDryNotified("uniswap-bsc-1"), true);
    assert.equal(tracker.markDryNotified("uniswap-bsc-1"), false);
    tracker.pruneDryNotified(new Set());
    assert.equal(tracker.markDryNotified("uniswap-bsc-1"), true);
  });
});
