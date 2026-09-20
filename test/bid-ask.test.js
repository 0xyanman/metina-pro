import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { collapseOpenLadders, isBidAskCard } from "../src/bid-ask.js";
import { closePayload, evaluateExit, positionKey } from "../src/evaluate-exit.js";
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
});
