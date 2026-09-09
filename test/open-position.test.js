import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  parseOpenCommand,
  pickOpenPool,
  buildDeployPayload,
  lookupBody,
  formatOpenUsage,
  formatOpenMessage,
} from "../src/open-position.js";

const TOKEN = "0x1111111111111111111111111111111111111111";
const POOL = "0x2222222222222222222222222222222222222222";

describe("parseOpenCommand", () => {
  test("requires token and amount", () => {
    assert.equal(parseOpenCommand([]).error, "usage");
    assert.equal(parseOpenCommand([TOKEN]).error, "usage");
  });

  test("rejects a non-EVM token", () => {
    assert.equal(parseOpenCommand(["BONK", "0.5"]).error, "token");
  });

  test("parses chain, sl/tp positional, and defaults the single-side range", () => {
    const spec = parseOpenCommand([TOKEN, "0.5", "robinhood", "-50", "20"]);
    assert.equal(spec.error, undefined);
    assert.equal(spec.token, TOKEN);
    assert.equal(spec.amount, 0.5);
    assert.equal(spec.chain, "robinhood");
    assert.equal(spec.stop_loss, -50);
    assert.equal(spec.take_profit, 20);
    assert.equal(spec.side, "single");
    assert.equal(spec.range_min_pct, -80);
    assert.equal(spec.range_max_pct, -1);
    assert.equal(spec.quote, "usdg");
  });

  test("defaults quote per chain like the Pro desk", () => {
    assert.equal(parseOpenCommand([TOKEN, "0.5", "base"]).quote, "usdc");
    assert.equal(parseOpenCommand([TOKEN, "0.5", "bsc"]).quote, "usdt");
    assert.equal(parseOpenCommand([TOKEN, "0.5"]).quote, "usdg");
  });

  test("quote=eth overrides the chain default", () => {
    const spec = parseOpenCommand([TOKEN, "0.5", "robinhood", "quote=eth"]);
    assert.equal(spec.quote, "eth");
    assert.equal(spec.chain, "robinhood");
  });

  test("bare usdt after chain is a quote, not an unknown arg", () => {
    const spec = parseOpenCommand([TOKEN, "100", "bsc", "usdt"]);
    assert.equal(spec.chain, "bsc");
    assert.equal(spec.quote, "usdt");
  });

  test("parses key=value options and hood alias", () => {
    const spec = parseOpenCommand([
      TOKEN,
      "100",
      "hood",
      "side=double",
      "sl=-40",
      "tp=15",
      "min=-60",
      "max=150",
      `pool=${POOL}`,
      "quote=usdg",
    ]);
    assert.equal(spec.chain, "robinhood");
    assert.equal(spec.side, "double");
    assert.equal(spec.stop_loss, -40);
    assert.equal(spec.take_profit, 15);
    assert.equal(spec.range_min_pct, -60);
    assert.equal(spec.range_max_pct, 150);
    assert.equal(spec.pool, POOL);
    assert.equal(spec.quote, "usdg");
  });
});

describe("pickOpenPool + deploy payload", () => {
  const lookup = {
    type: "uniswap",
    token: { mint: TOKEN, token: TOKEN, symbol: "MEME", pair: "MEME/USDG", chain: "robinhood", mcap: 1_000_000 },
    pools: [
      {
        venue: "uniswap",
        pool: "0xblocked",
        name: "BLOCKED/USDG",
        openable: false,
        chain: "robinhood",
        quote_symbol: "USDG",
      },
      {
        venue: "uniswap",
        pool: POOL,
        name: "MEME/USDG",
        openable: true,
        chain: "robinhood",
        quote_symbol: "USDG",
        token_address: TOKEN,
        fee: 10000,
        version: "v4",
        dex: "uniswap",
        liquidity_usd: 80_000,
        volume_24h: 12_000,
        grade: "A",
      },
    ],
  };

  test("skips blocked pools and prefers the first openable Uniswap pool", () => {
    const pool = pickOpenPool(lookup, { chain: "robinhood" });
    assert.equal(pool.pool, POOL);
  });

  test("prefers the quote token for that chain (USDG over ETH on robinhood)", () => {
    const mixed = {
      ...lookup,
      pools: [
        {
          venue: "uniswap",
          pool: "0x3333333333333333333333333333333333333333",
          name: "MEME/WETH",
          openable: true,
          chain: "robinhood",
          quote_symbol: "WETH",
        },
        ...lookup.pools,
      ],
    };
    const spec = parseOpenCommand([TOKEN, "0.5", "robinhood"]);
    assert.equal(spec.quote, "usdg");
    const pool = pickOpenPool(mixed, spec);
    assert.equal(pool.pool, POOL);
    assert.equal(pool.quote_symbol, "USDG");
  });

  test("returns null for Solana lookup", () => {
    assert.equal(pickOpenPool({ type: "pool", network: "solana", pools: [{ pool: "abc", openable: true }] }), null);
  });

  test("builds the same Uniswap deploy body as the desk Open button", () => {
    const spec = parseOpenCommand([TOKEN, "0.5", "robinhood", "sl=-50", "tp=20"]);
    const pool = pickOpenPool(lookup, spec);
    const payload = buildDeployPayload(lookup, pool, spec);
    assert.equal(payload.venue, "uniswap");
    assert.equal(payload.pool, POOL);
    assert.equal(payload.amount, 0.5);
    assert.equal(payload.amount_eth, 0.5);
    assert.equal(payload.amount_usdg, 0.5);
    assert.equal(payload.side, "single");
    assert.equal(payload.stop_loss, -50);
    assert.equal(payload.take_profit, 20);
    assert.equal(payload.range_min_pct, -80);
    assert.equal(payload.range_max_pct, -1);
    assert.equal(payload.chain, "robinhood");
    assert.equal(lookupBody(spec).token, TOKEN);
    assert.equal(lookupBody(spec).quote, "usdg");
  });
});

describe("open messages", () => {
  test("usage mentions LIVE_OPEN and an example", () => {
    const msg = formatOpenUsage();
    assert.match(msg, /\/open/);
    assert.match(msg, /robinhood/);
  });

  test("dry and success messages include pool + range", () => {
    const payload = {
      pair: "MEME/USDG",
      chain: "robinhood",
      amount: 0.5,
      range_min_pct: -80,
      range_max_pct: -1,
      stop_loss: -50,
      take_profit: 20,
    };
    const pool = { pool: POOL, name: "MEME/USDG", quote_symbol: "USDG", grade: "A" };
    const dry = formatOpenMessage({ pool, payload, dry: true });
    assert.match(dry, /Would Open/);
    assert.match(dry, /Quote: USDG/);
    assert.match(dry, /LIVE_OPEN=0/);
    const ok = formatOpenMessage({ pool, payload, result: { tx: "0xabc", position: "99" } });
    assert.match(ok, /Position Opened/);
    assert.match(ok, /0xabc/);
    assert.match(ok, /99/);
  });
});
