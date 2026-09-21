import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { collapseOpenLadders, isBidAskCard } from "../src/bid-ask.js";
import { closePayload, evaluateExit, livePnlPct, livePnlUsd, positionKey } from "../src/evaluate-exit.js";
import { formatOpenSummary, formatPnlBlock } from "../src/position-notify.js";
import { runCycle } from "../src/worker.js";

function rung(id, extra = {}) {
  return {
    poolType: "uniswap",
    chain: "robinhood",
    version: "v4",
    tokenId: id,
    position: id,
    pool: "0xpool",
    pair: "ASKR/USDG",
    quote_symbol: "USDG",
    wallet: "0xabc",
    created_at: "2026-09-19T12:00:00.000Z",
    ...extra,
  };
}

describe("EVM Bid-Ask collapse", () => {
  test("three adjacent rungs become one card with summed live PnL", () => {
    const out = collapseOpenLadders([
      rung("10", { tick_lower: 100, tick_upper: 200, current_value_usd: 50, input_value: 50, stop_loss_pct: -20, take_profit_pct: 10 }),
      rung("11", { tick_lower: 200, tick_upper: 300, current_value_usd: 33, input_value: 33 }),
      rung("12", { tick_lower: 300, tick_upper: 400, current_value_usd: 17, input_value: 17, pnl_usd: 1 }),
    ]);
    assert.equal(out.length, 1);
    assert.equal(isBidAskCard(out[0]), true);
    assert.deepEqual(out[0].ladder_token_ids, ["10", "11", "12"]);
    assert.ok(Math.abs(Number(out[0].current_value_usd) - 100) < 0.02);
    assert.ok(Math.abs(Number(out[0].initial_value_usd) - 100) < 0.02);
    assert.equal(out[0].stop_loss_pct, -20);
    assert.equal(out[0].take_profit_pct, 10);
  });

  test("cloned full-deposit stamps do not triple the cost", () => {
    const out = collapseOpenLadders([
      rung("21", { tick_lower: 100, tick_upper: 200, current_value_usd: 50, input_value: 100 }),
      rung("22", { tick_lower: 200, tick_upper: 300, current_value_usd: 33, input_value: 100 }),
      rung("23", { tick_lower: 300, tick_upper: 400, current_value_usd: 17, input_value: 100 }),
    ]);
    assert.equal(out.length, 1);
    assert.ok(Math.abs(Number(out[0].initial_value_usd) - 100) < 0.02);
    assert.ok(Number(out[0].pnl_pct) > -1 && Number(out[0].pnl_pct) < 1);
  });

  test("Spot LPs on the same pair stay unmerged", () => {
    const out = collapseOpenLadders([
      rung("31", { pair: "A/USDG", pool: "0xa", created_at: "2026-09-19T12:00:00.000Z", current_value_usd: 40, input_value: 40 }),
      rung("99", { pair: "A/USDG", pool: "0xa", created_at: "2026-09-18T12:00:00.000Z", current_value_usd: 40, input_value: 40 }),
    ]);
    assert.equal(out.length, 2);
  });

  test("one hot rung does not trip TP on a flat ladder", () => {
    const rungs = [
      rung("41", { tick_lower: 100, tick_upper: 200, current_value_usd: 40, input_value: 50, pnl_usd: -10, pnl_pct: -20 }),
      rung("42", { tick_lower: 200, tick_upper: 300, current_value_usd: 70, input_value: 33, pnl_usd: 37, pnl_pct: 112 }),
      rung("43", { tick_lower: 300, tick_upper: 400, current_value_usd: 20, input_value: 17, pnl_usd: 3, pnl_pct: 18 }),
    ];
    const card = collapseOpenLadders(rungs)[0];
    card.take_profit_pct = 40;
    const hit = evaluateExit(card);
    assert.equal(hit.action, null);
    assert.ok(Number(card.pnl_pct) < 40);
    assert.equal(evaluateExit({ ...rungs[1], take_profit_pct: 40 }).kind, "take_profit");
  });

  test("tracked desk id and inferred id share one watch key", () => {
    const ticks = [
      { tick_lower: 100, tick_upper: 200, current_value_usd: 50, input_value: 50 },
      { tick_lower: 200, tick_upper: 300, current_value_usd: 30, input_value: 30 },
      { tick_lower: 300, tick_upper: 400, current_value_usd: 20, input_value: 20 },
    ];
    const inferred = collapseOpenLadders([
      rung("71", ticks[0]),
      rung("72", ticks[1]),
      rung("73", ticks[2]),
    ])[0];
    const tracked = collapseOpenLadders([
      rung("71", { ...ticks[0], ladder_id: "lad:desk:askr", ladder_token_ids: ["71", "72", "73"] }),
      rung("72", { ...ticks[1], ladder_id: "lad:desk:askr", ladder_token_ids: ["71", "72", "73"] }),
      rung("73", { ...ticks[2], ladder_id: "lad:desk:askr", ladder_token_ids: ["71", "72", "73"] }),
    ])[0];
    assert.equal(positionKey(inferred), positionKey(tracked));
    assert.equal(positionKey(inferred), "uniswap-robinhood-lad:71,72,73");
  });

  test("close payload includes every Bid-Ask NFT id", () => {
    const card = collapseOpenLadders([
      rung("51", { tick_lower: 100, tick_upper: 200, current_value_usd: 50, input_value: 50 }),
      rung("52", { tick_lower: 200, tick_upper: 300, current_value_usd: 30, input_value: 30 }),
      rung("53", { tick_lower: 300, tick_upper: 400, current_value_usd: 20, input_value: 20 }),
    ])[0];
    const body = closePayload(card, { swap: true, kind: "stop_loss" });
    assert.deepEqual(body.ladder_token_ids, ["51", "52", "53"]);
    assert.equal(body.strategy, "bid_ask");
    assert.equal(positionKey(card), "uniswap-robinhood-lad:51,52,53");
    assert.equal(
      positionKey({ ...card, ladder_id: "lad:desk:askr" }),
      positionKey({ ...card, ladder_id: "lad:inf:robinhood:51" }),
    );
  });

  test("watch cycle closes the ladder once, not three rungs", async () => {
    const closed = [];
    const client = {
      async positions() {
        return {
          positions: [
            rung("61", { tick_lower: 100, tick_upper: 200, current_value_usd: 20, input_value: 50, stop_loss_pct: -40 }),
            rung("62", { tick_lower: 200, tick_upper: 300, current_value_usd: 20, input_value: 33, stop_loss_pct: -40 }),
            rung("63", { tick_lower: 300, tick_upper: 400, current_value_usd: 10, input_value: 17, stop_loss_pct: -40 }),
          ],
        };
      },
      async close(body) {
        closed.push(body);
        return { ok: true, success: true, tx: "0xlad" };
      },
    };
    const out = await runCycle(client, { liveClose: true, discover: false, hydrate: false }, new Set());
    assert.equal(out.count, 1);
    assert.equal(out.hits, 1);
    assert.equal(closed.length, 1);
    assert.deepEqual(closed[0].ladder_token_ids, ["61", "62", "63"]);
  });

  test("Bid-Ask $0 mark with token sides does not trip SL at −100%", () => {
    const hit = evaluateExit({
      poolType: "uniswap",
      chain: "robinhood",
      strategy: "bid_ask",
      ladder_rungs: 3,
      stop_loss_pct: -50,
      take_profit_pct: 10,
      total_value_usd: 0,
      entry_value_usd: 5500,
      pnl: {
        current_value_usd: 0,
        entry_value_usd: 5500,
        amount_eth_usd: 4000,
        amount_meme_usd: 1000,
        pnl_usd: 0,
        pnl_pct: 0,
      },
    });
    assert.equal(hit.action, null);
    assert.ok(livePnlPct({
      poolType: "uniswap",
      entry_value_usd: 5500,
      total_value_usd: 0,
      pnl: { current_value_usd: 0, entry_value_usd: 5500, amount_eth_usd: 4000, amount_meme_usd: 1000 },
    }) > -50);
  });

  test("one $0 rung still uses token sides so the ladder is not −50% SL", () => {
    const card = collapseOpenLadders([
      rung("81", {
        tick_lower: 100,
        tick_upper: 200,
        current_value_usd: 0,
        input_value: 50,
        stop_loss_pct: -40,
        pnl: { current_value_usd: 0, amount_eth_usd: 30, amount_meme_usd: 20 },
      }),
      rung("82", { tick_lower: 200, tick_upper: 300, current_value_usd: 33, input_value: 33 }),
      rung("83", { tick_lower: 300, tick_upper: 400, current_value_usd: 17, input_value: 17 }),
    ])[0];
    assert.ok(Math.abs(Number(card.current_value_usd) - 100) < 0.02, card.current_value_usd);
    assert.equal(evaluateExit(card).action, null);
  });

  test("overlay cost next to leftover slices is not summed for SL basis", () => {
    const card = collapseOpenLadders([
      rung("91", { tick_lower: 100, tick_upper: 200, current_value_usd: 0, input_value: 200, entry_value_usd: 200 }),
      rung("92", { tick_lower: 200, tick_upper: 300, current_value_usd: 66.67, input_value: 66.67, entry_value_usd: 66.67 }),
      rung("93", { tick_lower: 300, tick_upper: 400, current_value_usd: 100, input_value: 100, entry_value_usd: 100 }),
    ])[0];
    assert.ok(Math.abs(Number(card.initial_value_usd) - 200) < 0.05, card.initial_value_usd);
  });

  test("collapsed card plus raw rungs does not double-count Current", () => {
    const collapsed = rung("10", {
      tick_lower: 100,
      tick_upper: 400,
      current_value_usd: 100,
      input_value: 100,
      ladder_id: "lad:desk:askr",
      ladder_token_ids: ["10", "11", "12"],
      ladder_rungs: 3,
      ladder_primary: true,
    });
    const out = collapseOpenLadders([
      collapsed,
      rung("11", {
        tick_lower: 200,
        tick_upper: 300,
        current_value_usd: 33,
        input_value: 33,
        ladder_id: "lad:desk:askr",
        ladder_token_ids: ["10", "11", "12"],
      }),
      rung("12", {
        tick_lower: 300,
        tick_upper: 400,
        current_value_usd: 17,
        input_value: 17,
        ladder_id: "lad:desk:askr",
        ladder_token_ids: ["10", "11", "12"],
      }),
    ]);
    assert.equal(out.length, 1);
    assert.ok(Math.abs(Number(out[0].current_value_usd) - 100) < 0.02, out[0].current_value_usd);
  });

  test("duplicate NFT rows do not double-count Current or cost", () => {
    const a = rung("10", { tick_lower: 100, tick_upper: 200, current_value_usd: 50, input_value: 50 });
    const b = rung("11", { tick_lower: 200, tick_upper: 300, current_value_usd: 33, input_value: 33 });
    const c = rung("12", { tick_lower: 300, tick_upper: 400, current_value_usd: 17, input_value: 17 });
    const out = collapseOpenLadders([a, b, c, { ...a }, { ...b }]);
    assert.equal(out.length, 1);
    assert.ok(Math.abs(Number(out[0].current_value_usd) - 100) < 0.02, out[0].current_value_usd);
    assert.ok(Math.abs(Number(out[0].initial_value_usd) - 100) < 0.02, out[0].initial_value_usd);
  });

  test("Spot opened beside Bid-Ask on the same pool stays a separate card", () => {
    const out = collapseOpenLadders([
      rung("10", { tick_lower: 100, tick_upper: 200, current_value_usd: 50, input_value: 50 }),
      rung("11", { tick_lower: 200, tick_upper: 300, current_value_usd: 33, input_value: 33 }),
      rung("12", { tick_lower: 300, tick_upper: 400, current_value_usd: 17, input_value: 17 }),
      rung("88", {
        pair: "ASKR/USDG",
        pool: "0xpool",
        tokenId: "88",
        position: "88",
        tick_lower: 900,
        tick_upper: 1000,
        current_value_usd: 40,
        input_value: 40,
        strategy: "spot",
      }),
    ]);
    assert.equal(out.length, 2);
    const ladder = out.find((p) => isBidAskCard(p));
    const spot = out.find((p) => String(p.tokenId) === "88");
    assert.ok(ladder);
    assert.ok(spot);
    assert.deepEqual(ladder.ladder_token_ids, ["10", "11", "12"]);
    assert.equal(isBidAskCard(spot), false);
  });

  test("two-rung adjacent Bid-Ask still collapses", () => {
    const out = collapseOpenLadders([
      rung("10", { tick_lower: 100, tick_upper: 200, current_value_usd: 60, input_value: 60, stop_loss_pct: -25 }),
      rung("11", { tick_lower: 200, tick_upper: 300, current_value_usd: 40, input_value: 40 }),
    ]);
    assert.equal(out.length, 1);
    assert.equal(isBidAskCard(out[0]), true);
    assert.deepEqual(out[0].ladder_token_ids, ["10", "11"]);
    assert.ok(Math.abs(Number(out[0].current_value_usd) - 100) < 0.02);
  });

  test("SL copied from the last rung still watches the whole ladder", () => {
    const card = collapseOpenLadders([
      rung("10", { tick_lower: 100, tick_upper: 200, current_value_usd: 50, input_value: 50 }),
      rung("11", { tick_lower: 200, tick_upper: 300, current_value_usd: 33, input_value: 33 }),
      rung("12", { tick_lower: 300, tick_upper: 400, current_value_usd: 17, input_value: 17, stop_loss_pct: -15 }),
    ])[0];
    assert.equal(card.stop_loss_pct, -15);
  });

  test("real Bid-Ask loss still hits SL", () => {
    const card = collapseOpenLadders([
      rung("10", { tick_lower: 100, tick_upper: 200, current_value_usd: 20, input_value: 50, stop_loss_pct: -40 }),
      rung("11", { tick_lower: 200, tick_upper: 300, current_value_usd: 20, input_value: 33, stop_loss_pct: -40 }),
      rung("12", { tick_lower: 300, tick_upper: 400, current_value_usd: 10, input_value: 17, stop_loss_pct: -40 }),
    ])[0];
    const hit = evaluateExit(card);
    assert.equal(hit.kind, "stop_loss");
  });

  test("all three $0 marks still use summed token sides", () => {
    const card = collapseOpenLadders([
      rung("10", {
        tick_lower: 100, tick_upper: 200, current_value_usd: 0, input_value: 50, stop_loss_pct: -50,
        pnl: { current_value_usd: 0, amount_eth_usd: 30, amount_meme_usd: 20 },
      }),
      rung("11", {
        tick_lower: 200, tick_upper: 300, current_value_usd: 0, input_value: 33,
        pnl: { current_value_usd: 0, amount_eth_usd: 20, amount_meme_usd: 13 },
      }),
      rung("12", {
        tick_lower: 300, tick_upper: 400, current_value_usd: 0, input_value: 17,
        pnl: { current_value_usd: 0, amount_eth_usd: 10, amount_meme_usd: 7 },
      }),
    ])[0];
    assert.ok(Math.abs(Number(card.current_value_usd) - 100) < 0.02, card.current_value_usd);
    assert.equal(evaluateExit(card).action, null);
  });

  test("unclaimed already inside Current is not added again for TP", () => {
    const card = collapseOpenLadders([
      rung("10", {
        tick_lower: 100, tick_upper: 200, current_value_usd: 55, input_value: 50, take_profit_pct: 8,
        pnl: { current_value_usd: 55, unclaimed_fee_usd: 5, amount_eth_usd: 30, amount_meme_usd: 20 },
      }),
      rung("11", {
        tick_lower: 200, tick_upper: 300, current_value_usd: 36, input_value: 33,
        pnl: { current_value_usd: 36, unclaimed_fee_usd: 3, amount_eth_usd: 20, amount_meme_usd: 13 },
      }),
      rung("12", {
        tick_lower: 300, tick_upper: 400, current_value_usd: 19, input_value: 17,
        pnl: { current_value_usd: 19, unclaimed_fee_usd: 2, amount_eth_usd: 10, amount_meme_usd: 7 },
      }),
    ])[0];
    card.take_profit_pct = 15;
    const hit = evaluateExit(card);
    assert.equal(hit.action, null, `live ${livePnlPct(card)}% must not trip TP 15% from doubled fees`);
    const pct = livePnlPct(card);
    assert.ok(pct > 5 && pct < 15, pct);
  });

  test("claim cooldown on one rung skips TP for the whole ladder", () => {
    const card = collapseOpenLadders([
      rung("10", { tick_lower: 100, tick_upper: 200, current_value_usd: 60, input_value: 50, take_profit_pct: 5 }),
      rung("11", {
        tick_lower: 200, tick_upper: 300, current_value_usd: 40, input_value: 33,
        fees_claimed_at: new Date().toISOString(),
      }),
      rung("12", { tick_lower: 300, tick_upper: 400, current_value_usd: 20, input_value: 17 }),
    ])[0];
    card.take_profit_pct = 5;
    assert.equal(evaluateExit(card).action, null);
  });

  test("empty SL/TP on Bid-Ask does not use hidden -50 / +10", () => {
    const card = collapseOpenLadders([
      rung("10", { tick_lower: 100, tick_upper: 200, current_value_usd: 20, input_value: 50, stop_loss_pct: "", take_profit_pct: "" }),
      rung("11", { tick_lower: 200, tick_upper: 300, current_value_usd: 20, input_value: 33 }),
      rung("12", { tick_lower: 300, tick_upper: 400, current_value_usd: 10, input_value: 17 }),
    ])[0];
    assert.equal(evaluateExit(card).action, null);
  });

  test("one indexed Bid-Ask rung vs full cost does not trip SL", () => {
    const hit = evaluateExit({
      poolType: "uniswap",
      chain: "robinhood",
      strategy: "bid_ask",
      ladder_rungs: 3,
      ladder_token_ids: ["1", "2", "3"],
      stop_loss_pct: -50,
      take_profit_pct: 10,
      current_value_usd: 333,
      entry_value_usd: 2000,
      pnl: { current_value_usd: 333, entry_value_usd: 2000, pnl_pct: -83.35 },
    });
    assert.equal(hit.action, null);
  });

  test("Arc cloned $100 stamps stay one $100 cost", () => {
    const out = collapseOpenLadders([
      rung("21", {
        chain: "arc", pool: "0xarc", pair: "ARGUS/USDC", quote_symbol: "USDC",
        tick_lower: 10, tick_upper: 20, current_value_usd: 40, input_value: 100, entry_value_usd: 100,
      }),
      rung("22", {
        chain: "arc", pool: "0xarc", pair: "ARGUS/USDC", quote_symbol: "USDC",
        tick_lower: 20, tick_upper: 30, current_value_usd: 20, input_value: 100, entry_value_usd: 100,
      }),
      rung("23", {
        chain: "arc", pool: "0xarc", pair: "ARGUS/USDC", quote_symbol: "USDC",
        tick_lower: 30, tick_upper: 40, current_value_usd: 40, input_value: 100, entry_value_usd: 100,
      }),
    ]);
    assert.equal(out.length, 1);
    assert.ok(Math.abs(Number(out[0].initial_value_usd) - 100) < 0.02, out[0].initial_value_usd);
  });

  test("another pair on Robinhood stays unmerged", () => {
    const out = collapseOpenLadders([
      rung("10", { tick_lower: 100, tick_upper: 200, current_value_usd: 50, input_value: 50 }),
      rung("11", { tick_lower: 200, tick_upper: 300, current_value_usd: 33, input_value: 33 }),
      rung("12", { tick_lower: 300, tick_upper: 400, current_value_usd: 17, input_value: 17 }),
      rung("40", {
        pair: "PEPE/USDG", pool: "0xpepe",
        tick_lower: 100, tick_upper: 200, current_value_usd: 80, input_value: 80,
      }),
    ]);
    assert.equal(out.length, 2);
    assert.equal(out.filter((p) => p.pair === "ASKR/USDG").length, 1);
    assert.equal(out.filter((p) => p.pair === "PEPE/USDG").length, 1);
  });

  test("input_value-only Bid-Ask card still has a cost for SL", () => {
    const pct = livePnlPct({
      poolType: "uniswap",
      strategy: "bid_ask",
      input_value: 200,
      current_value_usd: 180,
      pnl: { current_value_usd: 180 },
      stop_loss_pct: -50,
    });
    assert.ok(pct != null && Math.abs(pct + 10) < 0.05, pct);
    assert.equal(evaluateExit({
      poolType: "uniswap",
      input_value: 200,
      current_value_usd: 180,
      pnl: { current_value_usd: 180 },
      stop_loss_pct: -50,
    }).action, null);
  });
});

describe("EVM Bid-Ask PnL and fees", () => {
  test("sums unclaimed and collected fees from every rung", () => {
    const card = collapseOpenLadders([
      rung("10", {
        tick_lower: 100, tick_upper: 200, current_value_usd: 50, input_value: 50,
        pnl: { unclaimed_fee_usd: 20, unclaimed_fees_quote: 10, fees_claimed_usd: 1.5 },
      }),
      rung("11", {
        tick_lower: 200, tick_upper: 300, current_value_usd: 33, input_value: 33,
        pnl: { unclaimed_fee_usd: 12, unclaimed_fees_quote: 5, fees_claimed_usd: 0.5 },
      }),
      rung("12", {
        tick_lower: 300, tick_upper: 400, current_value_usd: 17, input_value: 17,
        pnl: { unclaimed_fee_usd: 7.74, unclaimed_fees_quote: 3.26, fees_claimed_usd: 2 },
      }),
    ])[0];
    assert.ok(Math.abs(Number(card.pnl.unclaimed_fee_usd) - 39.74) < 0.02, card.pnl.unclaimed_fee_usd);
    assert.ok(Math.abs(Number(card.pnl.unclaimed_fees_quote) - 18.26) < 0.02, card.pnl.unclaimed_fees_quote);
    assert.ok(Math.abs(Number(card.pnl.fees_claimed_usd) - 4) < 0.02, card.pnl.fees_claimed_usd);
    assert.ok(Math.abs(Number(card.collected_fees_usd) - 4) < 0.02);
  });

  test("nested unclaimed still sums when top-level fee is 0", () => {
    const card = collapseOpenLadders([
      rung("10", {
        tick_lower: 100, tick_upper: 200, current_value_usd: 50, input_value: 50,
        unclaimed_fees_usd: 0, pnl: { unclaimed_fee_usd: 10, unclaimed_fees_quote: 10 },
      }),
      rung("11", {
        tick_lower: 200, tick_upper: 300, current_value_usd: 33, input_value: 33,
        unclaimed_fees_usd: 0, pnl: { unclaimed_fee_usd: 20, unclaimed_fees_quote: 20 },
      }),
      rung("12", {
        tick_lower: 300, tick_upper: 400, current_value_usd: 17, input_value: 17,
        unclaimed_fees_usd: 0, pnl: { unclaimed_fee_usd: 5, unclaimed_fees_quote: 5 },
      }),
    ])[0];
    assert.ok(Math.abs(Number(card.pnl.unclaimed_fee_usd) - 35) < 0.02, card.pnl.unclaimed_fee_usd);
  });

  test("quote-only unclaimed fees still count as Live PnL", () => {
    const card = collapseOpenLadders([
      rung("10", {
        tick_lower: 100, tick_upper: 200, current_value_usd: 50, input_value: 50,
        pnl: { unclaimed_fee_usd: 0, unclaimed_fees_quote: 10 },
      }),
      rung("11", {
        tick_lower: 200, tick_upper: 300, current_value_usd: 33, input_value: 33,
        pnl: { unclaimed_fee_usd: 0, unclaimed_fees_quote: 5 },
      }),
      rung("12", {
        tick_lower: 300, tick_upper: 400, current_value_usd: 17, input_value: 17,
        pnl: { unclaimed_fee_usd: 0, unclaimed_fees_quote: 3.26 },
      }),
    ])[0];
    assert.ok(Math.abs(Number(card.unclaimed_fee_usd) - 18.26) < 0.02, card.unclaimed_fee_usd);
    const usd = livePnlUsd(card);
    const pct = livePnlPct(card);
    assert.ok(Math.abs(usd - 18.26) < 0.05, usd);
    assert.ok(pct > 15 && pct < 22, pct);
  });

  test("inventory-only mark plus unclaimed is Live PnL and can trip TP", () => {
    const card = collapseOpenLadders([
      rung("10", {
        tick_lower: 100, tick_upper: 200, current_value_usd: 50, input_value: 50, take_profit_pct: 10,
        pnl: { current_value_usd: 50, unclaimed_fee_usd: 8, amount_eth_usd: 30, amount_meme_usd: 20 },
      }),
      rung("11", {
        tick_lower: 200, tick_upper: 300, current_value_usd: 33, input_value: 33,
        pnl: { current_value_usd: 33, unclaimed_fee_usd: 4, amount_eth_usd: 20, amount_meme_usd: 13 },
      }),
      rung("12", {
        tick_lower: 300, tick_upper: 400, current_value_usd: 17, input_value: 17,
        pnl: { current_value_usd: 17, unclaimed_fee_usd: 3, amount_eth_usd: 10, amount_meme_usd: 7 },
      }),
    ])[0];
    card.take_profit_pct = 10;
    const usd = livePnlUsd(card);
    const pct = livePnlPct(card);
    assert.ok(Math.abs(usd - 15) < 0.2, usd);
    assert.ok(pct >= 10, pct);
    assert.equal(evaluateExit(card).kind, "take_profit");
  });

  test("3:2:1 slice costs sum to the real deposit, not an overlay", () => {
    const card = collapseOpenLadders([
      rung("10", { tick_lower: 100, tick_upper: 200, current_value_usd: 100, input_value: 100, entry_value_usd: 100 }),
      rung("11", { tick_lower: 200, tick_upper: 300, current_value_usd: 67, input_value: 66.67, entry_value_usd: 66.67 }),
      rung("12", { tick_lower: 300, tick_upper: 400, current_value_usd: 33, input_value: 33.33, entry_value_usd: 33.33 }),
    ])[0];
    assert.ok(Math.abs(Number(card.initial_value_usd) - 200) < 0.05, card.initial_value_usd);
    assert.ok(Math.abs(livePnlUsd(card)) < 1, livePnlUsd(card));
  });

  test("claimed + unclaimed of the same harvest do not double for Bid-Ask TP", () => {
    const card = collapseOpenLadders([
      rung("10", {
        tick_lower: 100, tick_upper: 200, current_value_usd: 50, input_value: 50, take_profit_pct: 5,
        pnl: { current_value_usd: 50, unclaimed_fee_usd: 12, fees_claimed_usd: 12 },
      }),
      rung("11", {
        tick_lower: 200, tick_upper: 300, current_value_usd: 33, input_value: 33,
        pnl: { current_value_usd: 33, unclaimed_fee_usd: 8, fees_claimed_usd: 8 },
      }),
      rung("12", {
        tick_lower: 300, tick_upper: 400, current_value_usd: 17, input_value: 17,
        pnl: { current_value_usd: 17, unclaimed_fee_usd: 4, fees_claimed_usd: 4 },
      }),
    ])[0];
    card.take_profit_pct = 30;
    const usd = livePnlUsd(card);
    assert.ok(usd < 30, usd);
    assert.equal(evaluateExit(card).action, null);
  });

  test("Telegram PNL block uses summed Bid-Ask fees and Live %", () => {
    const card = collapseOpenLadders([
      rung("10", {
        tick_lower: 100, tick_upper: 200, current_value_usd: 52, input_value: 50,
        pnl: { unclaimed_fee_usd: 6, fees_claimed_usd: 1 },
      }),
      rung("11", {
        tick_lower: 200, tick_upper: 300, current_value_usd: 34, input_value: 33,
        pnl: { unclaimed_fee_usd: 4, fees_claimed_usd: 1 },
      }),
      rung("12", {
        tick_lower: 300, tick_upper: 400, current_value_usd: 18, input_value: 17,
        pnl: { unclaimed_fee_usd: 2, fees_claimed_usd: 1 },
      }),
    ])[0];
    const block = formatPnlBlock(card);
    assert.match(block, /Live:/);
    assert.match(block, /Unclaimed fees:/);
    assert.match(block, /Collected fees:/);
    const summary = formatOpenSummary([card]);
    assert.match(summary, /Bid-Ask/);
    assert.match(summary, /ASKR\/USDG/);
  });

  test("$0 mark Bid-Ask Live PnL uses token sides plus quote fees", () => {
    const card = collapseOpenLadders([
      rung("10", {
        tick_lower: 100, tick_upper: 200, current_value_usd: 0, input_value: 50, stop_loss_pct: -50,
        pnl: { current_value_usd: 0, amount_eth_usd: 30, amount_meme_usd: 20, unclaimed_fee_usd: 0, unclaimed_fees_quote: 4 },
      }),
      rung("11", {
        tick_lower: 200, tick_upper: 300, current_value_usd: 0, input_value: 33,
        pnl: { current_value_usd: 0, amount_eth_usd: 20, amount_meme_usd: 13, unclaimed_fees_quote: 3 },
      }),
      rung("12", {
        tick_lower: 300, tick_upper: 400, current_value_usd: 0, input_value: 17,
        pnl: { current_value_usd: 0, amount_eth_usd: 10, amount_meme_usd: 7, unclaimed_fees_quote: 2 },
      }),
    ])[0];
    assert.ok(Math.abs(Number(card.current_value_usd) - 100) < 0.02);
    const usd = livePnlUsd(card);
    const pct = livePnlPct(card);
    assert.ok(Math.abs(usd - 9) < 0.2, usd);
    assert.ok(pct > 5 && pct < 15, pct);
    assert.equal(evaluateExit(card).action, null);
  });

  test("fresh Bid-Ask fake unclaimed USD spike does not trip TP", () => {
    const now = new Date().toISOString();
    const card = collapseOpenLadders([
      rung("3013141", {
        tick_lower: 100, tick_upper: 200, current_value_usd: 1496.5, input_value: 1500,
        created_at: now, take_profit_pct: 4, stop_loss_pct: -20, current_price: 0.00352,
        pnl: {
          quote_symbol: "USDG", current_value_usd: 1496.5, pnl_usd: 0, pnl_pct: 0,
          unclaimed_fee_usd: 68.74, unclaimed_fees_quote: 0.72, unclaimed_fees_meme: 281.84,
          amount_meme: 2885, amount_meme_usd: 10.15, amount_eth_usd: 1486,
        },
      }),
      rung("3013142", {
        tick_lower: 200, tick_upper: 300, current_value_usd: 997.5, input_value: 1000,
        created_at: now, current_price: 0.00352,
        pnl: {
          quote_symbol: "USDG", current_value_usd: 997.5, pnl_usd: 0, pnl_pct: 0,
          unclaimed_fee_usd: 45.83, unclaimed_fees_quote: 0.48, unclaimed_fees_meme: 187.89,
          amount_meme: 1923, amount_meme_usd: 6.77, amount_eth_usd: 991,
        },
      }),
      rung("3013143", {
        tick_lower: 300, tick_upper: 400, current_value_usd: 499, input_value: 500,
        created_at: now, current_price: 0.00352,
        pnl: {
          quote_symbol: "USDG", current_value_usd: 499, pnl_usd: 0, pnl_pct: 0,
          unclaimed_fee_usd: 22.91, unclaimed_fees_quote: 0.25, unclaimed_fees_meme: 93.95,
          amount_meme: 962, amount_meme_usd: 3.39, amount_eth_usd: 496,
        },
      }),
    ])[0];
    card.take_profit_pct = 4;
    card.stop_loss_pct = -20;
    const usd = livePnlUsd(card);
    const pct = livePnlPct(card);
    assert.ok(usd < 10, usd);
    assert.ok(pct < 4, pct);
    assert.equal(evaluateExit(card).action, null);

    const quoteOnly = {
      poolType: "uniswap",
      strategy: "bid_ask",
      ladder_rungs: 3,
      ladder_token_ids: ["1", "2", "3"],
      quote_symbol: "USDG",
      created_at: now,
      current_value_usd: 3000,
      entry_value_usd: 3000,
      take_profit_pct: 4,
      stop_loss_pct: -20,
      pnl: {
        quote_symbol: "USDG",
        current_value_usd: 3000,
        entry_value_usd: 3000,
        pnl_usd: 0,
        pnl_pct: 0,
        unclaimed_fee_usd: 137.48,
      },
    };
    assert.ok(livePnlPct(quoteOnly) >= 4, livePnlPct(quoteOnly));
    assert.equal(evaluateExit(quoteOnly).action, null);
  });
});

function bidAskWatch(over = {}) {
  const current = over.current_value_usd ?? 3000;
  const entry = over.entry_value_usd ?? 3000;
  const { pnl: pnlOver, ...rest } = over;
  return {
    poolType: "uniswap",
    chain: "robinhood",
    strategy: "bid_ask",
    ladder_rungs: 3,
    ladder_token_ids: ["3013141", "3013142", "3013143"],
    quote_symbol: "USDG",
    created_at: "2026-09-19T12:00:00.000Z",
    current_value_usd: current,
    entry_value_usd: entry,
    stop_loss_pct: -20,
    take_profit_pct: 4,
    ...rest,
    pnl: {
      quote_symbol: "USDG",
      strategy: "bid_ask",
      current_value_usd: current,
      entry_value_usd: entry,
      pnl_reliable: false,
      ...pnlOver,
    },
  };
}

describe("Bid-Ask real vs fake TP/SL", () => {
  test("real inventory +10% hits TP 4%", () => {
    const card = bidAskWatch({
      current_value_usd: 3300,
      pnl: { pnl_usd: 300, pnl_pct: 10, pnl_reliable: false },
    });
    assert.ok(livePnlPct(card) >= 4, livePnlPct(card));
    assert.equal(evaluateExit(card).kind, "take_profit");
  });

  test("real inventory -50% hits SL -20%", () => {
    const card = bidAskWatch({
      current_value_usd: 1500,
      pnl: {
        pnl_usd: -1500,
        pnl_pct: -50,
        amount_eth_usd: 900,
        amount_meme_usd: 600,
      },
    });
    assert.ok(livePnlPct(card) <= -20, livePnlPct(card));
    assert.equal(evaluateExit(card).kind, "stop_loss");
  });

  test("real aged unclaimed quote fees hit TP even when printed is 0%", () => {
    const card = bidAskWatch({
      pnl: {
        pnl_usd: 0,
        pnl_pct: 0,
        unclaimed_fee_usd: 150,
        unclaimed_fees_quote: 150,
      },
    });
    assert.ok(livePnlPct(card) >= 4, livePnlPct(card));
    assert.equal(evaluateExit(card).kind, "take_profit");
  });

  test("real live below TP and SL does not close", () => {
    const card = bidAskWatch({
      current_value_usd: 3090,
      pnl: { pnl_usd: 90, pnl_pct: 3, unclaimed_fee_usd: 0 },
    });
    assert.ok(livePnlPct(card) > 0 && livePnlPct(card) < 4, livePnlPct(card));
    assert.equal(evaluateExit(card).action, null);

    const mildLoss = bidAskWatch({
      current_value_usd: 2700,
      pnl: { pnl_usd: -300, pnl_pct: -10, amount_eth_usd: 1600, amount_meme_usd: 1100 },
    });
    assert.ok(livePnlPct(mildLoss) > -20, livePnlPct(mildLoss));
    assert.equal(evaluateExit(mildLoss).action, null);
  });

  test("Pro unreliable flag still honors real Bid-Ask TP and SL", () => {
    assert.equal(evaluateExit(bidAskWatch({
      current_value_usd: 3180,
      pnl: { pnl_usd: 180, pnl_pct: 6, pnl_reliable: false },
    })).kind, "take_profit");
    assert.equal(evaluateExit(bidAskWatch({
      current_value_usd: 2100,
      pnl: {
        pnl_usd: -900,
        pnl_pct: -30,
        pnl_reliable: false,
        amount_eth_usd: 1200,
        amount_meme_usd: 900,
      },
    })).kind, "stop_loss");
  });

  test("Telegram fake Live 0% +$137.48 does not hit TP 4%", () => {
    const shot = bidAskWatch({
      created_at: new Date().toISOString(),
      current_value_usd: 3000,
      pnl: {
        pnl_usd: 0,
        pnl_pct: -0.00,
        pnl_reliable: false,
        unclaimed_fee_usd: 137.48,
        unclaimed_fees_quote: 1.45,
        unclaimed_fees_meme: 563.68,
        amount_meme: 5770,
        amount_meme_usd: 20.31,
        amount_eth_usd: 2973,
      },
      current_price: 0.00352,
    });
    assert.ok(livePnlPct(shot) < 4, livePnlPct(shot));
    assert.equal(evaluateExit(shot).action, null);
  });

  test("fresh Bid-Ask spike still skipped when overlay copies it into pnl_usd", () => {
    const card = bidAskWatch({
      created_at: new Date().toISOString(),
      current_value_usd: 3000,
      pnl: {
        pnl_usd: 137.48,
        pnl_pct: 0,
        pnl_reliable: false,
        unclaimed_fee_usd: 137.48,
      },
    });
    assert.ok(livePnlPct(card) >= 4, livePnlPct(card));
    assert.equal(evaluateExit(card).action, null);
  });

  test("fresh Bid-Ask spike still skipped when overlay copies on-chain −80%", () => {
    const card = bidAskWatch({
      created_at: new Date().toISOString(),
      current_value_usd: 3000,
      pnl: {
        pnl_usd: 0,
        pnl_pct: -80,
        onchain_pnl_pct: -80,
        pnl_reliable: false,
        unclaimed_fee_usd: 137.48,
      },
    });
    assert.ok(livePnlPct(card) >= 4, livePnlPct(card));
    assert.equal(evaluateExit(card).action, null);
  });

  test("wrong meme unit price that reprints $137 still does not TP while fresh", () => {
    const card = bidAskWatch({
      created_at: new Date().toISOString(),
      current_price: 0.24,
      pnl: {
        pnl_usd: 0,
        pnl_pct: 0,
        unclaimed_fee_usd: 137.48,
        unclaimed_fees_quote: 1.45,
        unclaimed_fees_meme: 563.68,
      },
    });
    assert.ok(livePnlPct(card) >= 4, livePnlPct(card));
    assert.equal(evaluateExit(card).action, null);
  });

  test("implied inventory price beats a wrong spot so aged $137 spike is not TP", () => {
    const card = bidAskWatch({
      current_price: 0.24,
      pnl: {
        pnl_usd: 0,
        pnl_pct: 0,
        unclaimed_fee_usd: 137.48,
        unclaimed_fees_quote: 1.45,
        unclaimed_fees_meme: 563.68,
        amount_meme: 5770,
        amount_meme_usd: 20.31,
        amount_eth_usd: 2973,
      },
    });
    assert.ok(livePnlPct(card) < 4, livePnlPct(card));
    assert.equal(evaluateExit(card).action, null);
  });

  test("fake on-chain -80% with flat live inventory does not hit SL", () => {
    const card = bidAskWatch({
      current_value_usd: 2993,
      pnl: {
        pnl_usd: 0,
        pnl_pct: -80,
        onchain_pnl_pct: -80,
        amount_eth_usd: 2970,
        amount_meme_usd: 23,
      },
    });
    assert.ok(livePnlPct(card) > -20, livePnlPct(card));
    assert.equal(evaluateExit(card).action, null);
  });

  test("fake $0 mark and one-rung indexer print do not hit SL", () => {
    assert.equal(evaluateExit(bidAskWatch({
      current_value_usd: 0,
      total_value_usd: 0,
      pnl: { current_value_usd: 0, pnl_usd: 0, pnl_pct: -100 },
    })).action, null);
    assert.equal(evaluateExit(bidAskWatch({
      current_value_usd: 500,
      pnl: { current_value_usd: 500, pnl_usd: -2500, pnl_pct: -83 },
    })).action, null);
  });

  test("empty Bid-Ask SL/TP never uses hidden -50/+10", () => {
    const card = bidAskWatch({
      current_value_usd: 1500,
      stop_loss_pct: "",
      take_profit_pct: "",
      pnl: { pnl_usd: -1500, pnl_pct: -50 },
    });
    assert.equal(evaluateExit(card).action, null);
  });

  test("fresh Bid-Ask claimed 5/6 deposit does not trip TP", () => {
    const card = bidAskWatch({
      current_value_usd: 999.999997,
      entry_value_usd: 1000,
      age_minutes: 3,
      take_profit_pct: 10,
      stop_loss_pct: -57,
      pnl: {
        pnl_usd: -0.000003,
        pnl_pct: 0,
        pnl_reliable: false,
        unclaimed_fee_usd: 0,
        unclaimed_fees_quote: 0,
        unclaimed_fees_meme: 0,
        fees_claimed_usd: 833.3522029083796,
        fees_claimed_usdg: 833.3522029083796,
        amount_eth_usd: 999.999997,
        amount_meme_usd: 0,
      },
    });
    assert.ok(Math.abs(livePnlUsd(card)) < 1, livePnlUsd(card));
    assert.ok(livePnlPct(card) < 10, livePnlPct(card));
    assert.equal(evaluateExit(card).action, null);
  });

  test("aged Bid-Ask claimed 5/6 with small unclaimed and −0.26% print does not TP", () => {
    const card = bidAskWatch({
      current_value_usd: 2987.64,
      entry_value_usd: 3000,
      age_minutes: 165,
      take_profit_pct: 10,
      stop_loss_pct: -57,
      pnl: {
        pnl_usd: -7.71,
        pnl_pct: -0.257,
        pnl_reliable: false,
        unclaimed_fee_usd: 4.69,
        unclaimed_fees_quote: 2.02,
        unclaimed_fees_meme: 797,
        fees_claimed_usd: 2499.26,
        fees_claimed_usdg: 2499.26,
        amount_eth_usd: 2913,
        amount_meme_usd: 81,
      },
    });
    assert.ok(livePnlPct(card) < 10, livePnlPct(card));
    assert.equal(evaluateExit(card).action, null);
  });

  test("fresh Bid-Ask spike folded into current_value does not trip TP", () => {
    const card = bidAskWatch({
      created_at: new Date().toISOString(),
      current_value_usd: 3137.48,
      pnl: {
        current_value_usd: 3137.48,
        pnl_usd: 137.48,
        pnl_pct: 4.58,
        unclaimed_fee_usd: 137.48,
      },
    });
    assert.ok(livePnlPct(card) >= 4, livePnlPct(card));
    assert.equal(evaluateExit(card).action, null);
  });

  test("leftover claimed 5/6 still ignored when overlay copies it into pnl_usd", () => {
    const card = bidAskWatch({
      current_value_usd: 3000,
      take_profit_pct: 10,
      pnl: {
        pnl_usd: 2499.26,
        pnl_pct: 83,
        fees_claimed_usd: 2499.26,
        unclaimed_fee_usd: 4.69,
      },
    });
    assert.ok(livePnlPct(card) < 10, livePnlPct(card));
    assert.equal(evaluateExit(card).action, null);
  });

  test("real Bid-Ask collected fees still hit TP", () => {
    const card = bidAskWatch({
      current_value_usd: 100,
      entry_value_usd: 100,
      take_profit_pct: 10,
      pnl: {
        pnl_usd: 0,
        pnl_pct: 0,
        unclaimed_fee_usd: 0,
        fees_claimed_usd: 15,
        amount_eth_usd: 60,
        amount_meme_usd: 40,
      },
    });
    assert.ok(livePnlPct(card) >= 10, livePnlPct(card));
    assert.equal(evaluateExit(card).kind, "take_profit");
  });
});
