import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { closePayload, evaluateExit, livePnlPct, livePnlUsd, positionKey, watchLine } from "../src/evaluate-exit.js";

describe("TP/SL rules (same as Metina Pro desk)", () => {
  test("hits stop loss when on-chain PnL is reliable", () => {
    const hit = evaluateExit({
      poolType: "uniswap",
      pnl: { pnl_pct: -80, pnl_reliable: true },
      pnl_reliable: true,
      stop_loss_pct: -50,
      take_profit_pct: 10,
    });
    assert.equal(hit.action, "close");
    assert.equal(hit.kind, "stop_loss");
  });

  test("hits Live PNL even when Pro flags V4/LPAgent unreliable", () => {
    const hit = evaluateExit({
      poolType: "uniswap",
      pnl: { onchain_pnl_pct: 5.2, pnl_pct: 5.2, pnl_reliable: false },
      take_profit_pct: 5,
    });
    assert.equal(hit.kind, "take_profit");
    const below = evaluateExit({
      poolType: "uniswap",
      pnl: { onchain_pnl_pct: 4.7, pnl_pct: 4.7, pnl_reliable: false },
      take_profit_pct: 5,
    });
    assert.equal(below.action, null);
  });

  test("uses Live PNL %, not on-chain inventory mark", () => {
    const liveHit = evaluateExit({
      poolType: "uniswap",
      pnl: {
        pnl_pct: 10.14,
        pnl_usd: 9.13,
        onchain_pnl_pct: -3.54,
        unclaimed_fee_usd: 9.07,
        current_value_usd: 90.06,
      },
      stop_loss_pct: -5,
      take_profit_pct: 3,
    });
    assert.equal(liveHit.kind, "take_profit");

    const liveBelow = evaluateExit({
      poolType: "uniswap",
      pnl_reliable: true,
      pnl: { pnl_pct: -4.52, onchain_pnl_pct: -80, pnl_reliable: true },
      stop_loss_pct: -50,
      take_profit_pct: 10,
    });
    assert.equal(liveBelow.action, null);
  });

  test("BLAST-style: SL uses LP value + fees, not on-chain inventory %", () => {
    const blastOpen = {
      poolType: "uniswap",
      pair: "BLAST/USDG",
      stop_loss_pct: -10,
      pnl: {
        pnl_pct: 5.29,
        pnl_usd: 4.73,
        onchain_pnl_pct: -10.61,
        current_value_usd: 89.39,
        unclaimed_fee_usd: 15.33,
        fees_claimed_usd: 0,
        amount_meme_usd: 34.97,
        amount_eth_usd: 54.43,
      },
    };
    assert.equal(evaluateExit(blastOpen).action, null);
    assert.ok(livePnlPct(blastOpen) > 0);
    assert.ok(livePnlUsd(blastOpen) > 4);

    const blastCloseSnapshot = {
      poolType: "uniswap",
      pair: "BLAST/USDG",
      stop_loss_pct: -10,
      pnl: {
        // API copied on-chain % into Live — that used to false-trigger SL -10%.
        pnl_pct: -16.86,
        pnl_usd: -2.28,
        onchain_pnl_pct: -16.86,
        current_value_usd: 83.14,
        unclaimed_fee_usd: 14.76,
        fees_claimed_usd: 0,
      },
    };
    const hit = evaluateExit(blastCloseSnapshot);
    assert.equal(hit.action, null, `live ${livePnlPct(blastCloseSnapshot)}% should not hit SL -10%`);
    assert.ok(livePnlPct(blastCloseSnapshot) > -10);
    assert.ok(Math.abs(livePnlUsd(blastCloseSnapshot) + 2.1) < 0.5);
  });

  test("falls back to on-chain % when Live PNL is missing", () => {
    const hit = evaluateExit({
      poolType: "uniswap",
      pnl: { onchain_pnl_pct: -80 },
      stop_loss_pct: -50,
    });
    assert.equal(hit.kind, "stop_loss");
  });

  test("empty thresholds do not use hidden defaults", () => {
    const empty = evaluateExit({
      poolType: "uniswap",
      pnl_reliable: true,
      pnl: { pnl_pct: -80, pnl_reliable: true },
      stop_loss_pct: "",
      take_profit_pct: "",
    });
    assert.equal(empty.action, null);
  });

  test("native-quote unit-mix % does not trip TP", () => {
    const hit = evaluateExit({
      poolType: "uniswap",
      pair: "PIPEDOG/WETH",
      quote_symbol: "WETH",
      take_profit_pct: 3,
      stop_loss_pct: -15,
      pnl: {
        quote_symbol: "WETH",
        pnl_pct: 245388,
        onchain_pnl_pct: 245388,
        pnl_usd: -0.004,
        current_value_usd: 2454.88,
      },
    });
    assert.equal(hit.action, null);
  });

  test("principal-seeded entry does not trip TP", () => {
    const seeded = evaluateExit({
      poolType: "uniswap",
      entry_seeded_from_principal: true,
      pnl_reliable: true,
      pnl: { pnl_pct: 1200, pnl_reliable: true },
      take_profit_pct: 10,
    });
    assert.equal(seeded.action, null);
  });

  test("hits take profit", () => {
    const hit = evaluateExit({
      poolType: "uniswap",
      pnl_reliable: true,
      pnl: { onchain_pnl_pct: 25, pnl_reliable: true },
      stop_loss_pct: -40,
      take_profit_pct: 20,
    });
    assert.equal(hit.kind, "take_profit");
  });

  test("watchLine prints live %", () => {
    const line = watchLine({
      pair: "HOOD10/USDG",
      stop_loss_pct: -5,
      take_profit_pct: 3,
      pnl: { pnl_pct: 10.14, onchain_pnl_pct: -3.54 },
    });
    assert.match(line, /live=10\.14/);
    assert.match(line, /onchain=-3\.54/);
    assert.match(line, /take_profit/);
  });

  test("positionKey is stable", () => {
    assert.equal(
      positionKey({ poolType: "uniswap", chain: "bsc", position: "99" }),
      "uniswap-bsc-99",
    );
  });

  test("closePayload maps the desk close body", () => {
    const body = closePayload({
      poolType: "uniswap",
      position: "77",
      chain: "bsc",
      pair: "CAT-USDT",
      pool: "0xpool",
      mint: "0xtoken",
      fee: 3000,
      version: "v3",
      dex: "pancake",
    }, { swap: true, kind: "take_profit" });
    assert.equal(body.venue, "uniswap");
    assert.equal(body.position, "77");
    assert.equal(body.tokenId, "77");
    assert.equal(body.kind, "take_profit");
    assert.equal(body.swap, true);
  });

  test("skips readonly and already-closed rows", () => {
    assert.equal(evaluateExit({ readonly: true, stop_loss_pct: -10, pnl_reliable: true, pnl: { pnl_pct: -80, pnl_reliable: true } }).action, null);
    assert.equal(evaluateExit({ closed_on_chain: true, stop_loss_pct: -10, pnl_reliable: true, pnl: { pnl_pct: -80, pnl_reliable: true } }).action, null);
  });

  test("claim-only fee lag does not trip take profit", () => {
    const staleHarvest = evaluateExit({
      poolType: "uniswap",
      take_profit_pct: 3,
      stop_loss_pct: -15,
      pnl: {
        pnl_pct: 8.2,
        pnl_usd: 0,
        unclaimed_fee_usd: 40,
        fees_claimed_usd: 40,
        current_value_usd: 1000,
      },
    });
    assert.equal(staleHarvest.action, null);

    const justClaimed = evaluateExit({
      poolType: "uniswap",
      take_profit_pct: 3,
      fees_claimed_at: new Date().toISOString(),
      pnl: {
        pnl_pct: 10.14,
        pnl_usd: 9.13,
        unclaimed_fee_usd: 0,
        fees_claimed_usd: 40,
        current_value_usd: 90.06,
      },
    });
    assert.equal(justClaimed.action, null);
  });
});
