import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { handleTelegramCommand } from "../src/worker.js";

describe("handleTelegramCommand", () => {
  test("/help sends help instructions", async () => {
    const sent = [];
    const notifier = {
      send: async (msg) => {
        sent.push(msg);
        return { ok: true };
      },
    };

    await handleTelegramCommand(
      { cmd: "/help", args: [], raw: "/help" },
      { client: {}, notifier, tracker: null, inflight: new Set() }
    );

    assert.equal(sent.length, 1);
    assert.match(sent[0], /Metina TPSL Bot Commands/);
  });

  test("/refresh fetches positions with discover=true and sends summary", async () => {
    const sent = [];
    const notifier = {
      send: async (msg) => {
        sent.push(msg);
        return { ok: true };
      },
    };

    let capturedDiscover = false;
    let capturedHydrate = false;
    const client = {
      positions: async ({ discover, hydrate }) => {
        capturedDiscover = discover;
        capturedHydrate = hydrate;
        return {
          positions: [
            {
              position: "933596",
              pair: "PONSBOT/USDG",
              chain: "robinhood",
            },
          ],
        };
      },
    };

    await handleTelegramCommand(
      { cmd: "/refresh", args: [], raw: "/refresh" },
      { client, notifier, tracker: null, inflight: new Set() }
    );

    assert.equal(capturedDiscover, true);
    assert.equal(capturedHydrate, true);
    assert.equal(sent.length, 2);
    assert.match(sent[0], /Mengambil data posisi/);
    assert.match(sent[1], /Open Positions/);
    assert.match(sent[1], /933596/);
  });

  test("/close 933596 closes specific position", async () => {
    const sent = [];
    const notifier = {
      send: async (msg) => {
        sent.push(msg);
        return { ok: true };
      },
    };

    let closedBody = null;
    const client = {
      positions: async () => ({
        positions: [
          {
            position: "933596",
            pair: "PONSBOT/USDG",
            chain: "robinhood",
          },
        ],
      }),
      close: async (body) => {
        closedBody = body;
        return { ok: true, tx: "0x123" };
      },
    };

    const inflight = new Set();
    await handleTelegramCommand(
      { cmd: "/close", args: ["933596"], raw: "/close 933596" },
      { client, notifier, tracker: null, inflight, liveClose: true }
    );

    assert.equal(closedBody.position, "933596");
    assert.equal(inflight.size, 1); // stays in-flight after successful close
    assert.equal(sent.length, 2);
    assert.match(sent[0], /Memproses penutupan posisi/);
    assert.match(sent[1], /Position Closed/);
  });

  test("/close invalid_id reports position not found", async () => {
    const sent = [];
    const notifier = {
      send: async (msg) => {
        sent.push(msg);
        return { ok: true };
      },
    };

    const client = {
      positions: async () => ({
        positions: [
          { position: "933596", pair: "PONSBOT/USDG" },
        ],
      }),
    };

    await handleTelegramCommand(
      { cmd: "/close", args: ["999999"], raw: "/close 999999" },
      { client, notifier, tracker: null, inflight: new Set(), liveClose: true }
    );

    assert.equal(sent.length, 1);
    assert.match(sent[0], /tidak ditemukan/);
  });

  test("/close all closes all open positions", async () => {
    const sent = [];
    const notifier = {
      send: async (msg) => {
        sent.push(msg);
        return { ok: true };
      },
    };

    const closedBodies = [];
    let capturedDiscover = false;
    const client = {
      positions: async ({ discover }) => {
        capturedDiscover = discover;
        return {
          positions: [
            { position: "101", pair: "AAA/USD" },
            { position: "102", pair: "BBB/USD" },
          ],
        };
      },
      close: async (body) => {
        closedBodies.push(body);
        return { ok: true, tx: "0x123" };
      },
    };

    const inflight = new Set();
    await handleTelegramCommand(
      { cmd: "/close", args: ["all"], raw: "/close all" },
      { client, notifier, tracker: null, inflight, liveClose: true }
    );

    assert.equal(capturedDiscover, true);
    assert.equal(closedBodies.length, 2);
    assert.equal(inflight.size, 2);
    assert.equal(sent.length, 3); // 1 summary start message + 2 position close messages
    assert.match(sent[0], /Memproses penutupan <b>2 posisi open<\/b>/);
  });

  test("/close profit discovers latest positions and closes only profitable ones", async () => {
    const sent = [];
    const notifier = {
      send: async (msg) => {
        sent.push(msg);
        return { ok: true };
      },
    };

    let capturedDiscover = false;
    const closedBodies = [];
    const client = {
      positions: async ({ discover }) => {
        capturedDiscover = discover;
        return {
          positions: [
            { position: "101", pair: "PROFIT/USD", pnl: { pnl_pct: 12.5, pnl_usd: 5.0 } },
            { position: "102", pair: "LOSS/USD", pnl: { pnl_pct: -8.0, pnl_usd: -2.0 } },
          ],
        };
      },
      close: async (body) => {
        closedBodies.push(body);
        return { ok: true, tx: "0x789" };
      },
    };

    const inflight = new Set();
    await handleTelegramCommand(
      { cmd: "/close", args: ["profit"], raw: "/close profit" },
      { client, notifier, tracker: null, inflight, liveClose: true }
    );

    assert.equal(capturedDiscover, true); // Verified that discover: true was used!
    assert.equal(closedBodies.length, 1);
    assert.equal(closedBodies[0].position, "101");
    assert.equal(sent.length, 2); // 1 start message + 1 close result
    assert.match(sent[0], /Memproses penutupan <b>1 posisi profit<\/b>/);
  });

  test("/close profit notifies when no open positions are in profit", async () => {
    const sent = [];
    const notifier = {
      send: async (msg) => {
        sent.push(msg);
        return { ok: true };
      },
    };

    const client = {
      positions: async ({ discover }) => {
        return {
          positions: [
            { position: "102", pair: "LOSS/USD", pnl: { pnl_pct: -8.0, pnl_usd: -2.0 } },
          ],
        };
      },
    };

    await handleTelegramCommand(
      { cmd: "/close", args: ["profit"], raw: "/close profit" },
      { client, notifier, tracker: null, inflight: new Set(), liveClose: true }
    );

    assert.equal(sent.length, 1);
    assert.match(sent[0], /Tidak ada posisi open yang sedang profit/);
  });

  test("/close without a target does not close anything", async () => {
    const sent = [];
    let closed = 0;
    const notifier = {
      send: async (msg) => {
        sent.push(msg);
        return { ok: true };
      },
    };
    const client = {
      positions: async () => ({ positions: [{ position: "101", pair: "AAA/USD" }] }),
      close: async () => {
        closed += 1;
        return { ok: true };
      },
    };

    await handleTelegramCommand(
      { cmd: "/close", args: [], raw: "/close" },
      { client, notifier, tracker: null, inflight: new Set(), liveClose: true }
    );

    assert.equal(closed, 0);
    assert.equal(sent.length, 1);
    assert.match(sent[0], /butuh target/);
  });

  test("/close is ignored when LIVE_CLOSE is off", async () => {
    const sent = [];
    let closed = 0;
    const notifier = {
      send: async (msg) => {
        sent.push(msg);
        return { ok: true };
      },
    };
    const client = {
      positions: async () => ({ positions: [{ position: "101", pair: "AAA/USD" }] }),
      close: async () => {
        closed += 1;
        return { ok: true };
      },
    };

    await handleTelegramCommand(
      { cmd: "/close", args: ["all"], raw: "/close all" },
      { client, notifier, tracker: null, inflight: new Set(), liveClose: false }
    );

    assert.equal(closed, 0);
    assert.equal(sent.length, 1);
    assert.match(sent[0], /LIVE_CLOSE=0/);
  });

  test("/close 1 matches the numbered card from the sorted summary", async () => {
    const sent = [];
    let closedId = null;
    const notifier = {
      send: async (msg) => {
        sent.push(msg);
        return { ok: true };
      },
    };
    const client = {
      positions: async () => ({
        positions: [
          { position: "933596", pair: "MARTIANS/USDG", chain: "robinhood" },
          { position: "933597", pair: "HOOD10/USDG", chain: "robinhood" },
        ],
      }),
      close: async (body) => {
        closedId = body.position;
        return { ok: true, tx: "0x1" };
      },
    };

    await handleTelegramCommand(
      { cmd: "/close", args: ["1"], raw: "/close 1" },
      { client, notifier, tracker: null, inflight: new Set(), liveClose: true }
    );

    // Summary sorts HOOD10 before MARTIANS, so /close 1 must close HOOD10
    assert.equal(closedId, "933597");
  });

  test("/close sibling Bid-Ask NFT id closes the whole ladder once", async () => {
    const sent = [];
    const closed = [];
    const notifier = {
      send: async (msg) => {
        sent.push(msg);
        return { ok: true };
      },
    };
    const client = {
      positions: async () => ({
        positions: [
          {
            poolType: "uniswap",
            chain: "robinhood",
            tokenId: "10",
            position: "10",
            pair: "ASKR/USDG",
            pool: "0xpool",
            wallet: "0xabc",
            created_at: "2026-09-19T12:00:00.000Z",
            tick_lower: 100,
            tick_upper: 200,
            current_value_usd: 50,
            input_value: 50,
          },
          {
            poolType: "uniswap",
            chain: "robinhood",
            tokenId: "11",
            position: "11",
            pair: "ASKR/USDG",
            pool: "0xpool",
            wallet: "0xabc",
            created_at: "2026-09-19T12:00:00.000Z",
            tick_lower: 200,
            tick_upper: 300,
            current_value_usd: 33,
            input_value: 33,
          },
          {
            poolType: "uniswap",
            chain: "robinhood",
            tokenId: "12",
            position: "12",
            pair: "ASKR/USDG",
            pool: "0xpool",
            wallet: "0xabc",
            created_at: "2026-09-19T12:00:00.000Z",
            tick_lower: 300,
            tick_upper: 400,
            current_value_usd: 17,
            input_value: 17,
          },
        ],
      }),
      close: async (body) => {
        closed.push(body);
        return { ok: true, tx: "0xlad" };
      },
    };

    await handleTelegramCommand(
      { cmd: "/close", args: ["12"], raw: "/close 12" },
      { client, notifier, tracker: null, inflight: new Set(), liveClose: true }
    );

    assert.equal(closed.length, 1);
    assert.deepEqual(closed[0].ladder_token_ids, ["10", "11", "12"]);
    assert.equal(closed[0].strategy, "bid_ask");
  });

  test("/open without args sends usage", async () => {
    const sent = [];
    const notifier = {
      send: async (msg) => {
        sent.push(msg);
        return { ok: true };
      },
    };
    await handleTelegramCommand(
      { cmd: "/open", args: [], raw: "/open" },
      { client: {}, notifier, inflight: new Set(), liveOpen: true }
    );
    assert.equal(sent.length, 1);
    assert.match(sent[0], /butuh token EVM/);
  });

  test("/open with LIVE_OPEN off looks up but does not deploy", async () => {
    const sent = [];
    let deployed = 0;
    const notifier = {
      send: async (msg) => {
        sent.push(msg);
        return { ok: true };
      },
    };
    const token = "0x1111111111111111111111111111111111111111";
    const client = {
      lookup: async () => ({
        type: "uniswap",
        token: { mint: token, pair: "MEME/USDG", chain: "robinhood" },
        pools: [{
          venue: "uniswap",
          pool: "0x2222222222222222222222222222222222222222",
          name: "MEME/USDG",
          openable: true,
          chain: "robinhood",
          quote_symbol: "USDG",
        }],
      }),
      deploy: async () => {
        deployed += 1;
        return { ok: true, success: true };
      },
    };

    await handleTelegramCommand(
      { cmd: "/open", args: [token, "0.5", "robinhood"], raw: `/open ${token} 0.5 robinhood` },
      { client, notifier, inflight: new Set(), liveOpen: false }
    );

    assert.equal(deployed, 0);
    assert.match(sent.join("\n"), /Would Open/);
    assert.match(sent.join("\n"), /LIVE_OPEN=0/);
  });

  test("/open with LIVE_OPEN on deploys the picked Uniswap pool", async () => {
    const sent = [];
    let deployed = null;
    const notifier = {
      send: async (msg) => {
        sent.push(msg);
        return { ok: true };
      },
    };
    const token = "0x1111111111111111111111111111111111111111";
    const client = {
      lookup: async (body) => {
        assert.equal(body.token, token);
        assert.equal(body.chain, "robinhood");
        return {
          type: "uniswap",
          token: { mint: token, pair: "MEME/USDG", chain: "robinhood" },
          pools: [{
            venue: "uniswap",
            pool: "0x2222222222222222222222222222222222222222",
            name: "MEME/USDG",
            openable: true,
            chain: "robinhood",
            quote_symbol: "USDG",
            token_address: token,
          }],
        };
      },
      deploy: async (body) => {
        deployed = body;
        return { ok: true, success: true, tx: "0xopen", position: "42" };
      },
      positions: async ({ discover, hydrate }) => {
        assert.equal(discover, true);
        assert.equal(hydrate, true);
        return { positions: [] };
      },
    };

    await handleTelegramCommand(
      { cmd: "/open", args: [token, "0.5", "robinhood", "sl=-50", "tp=20"], raw: `/open ${token} 0.5 robinhood sl=-50 tp=20` },
      { client, notifier, inflight: new Set(), liveOpen: true }
    );

    assert.equal(deployed.venue, "uniswap");
    assert.equal(deployed.pool, "0x2222222222222222222222222222222222222222");
    assert.equal(deployed.amount_usdg, 0.5);
    assert.equal(deployed.stop_loss, -50);
    assert.equal(deployed.take_profit, 20);
    assert.match(sent.join("\n"), /Position Opened/);
    assert.match(sent.join("\n"), /0xopen/);
  });
});
