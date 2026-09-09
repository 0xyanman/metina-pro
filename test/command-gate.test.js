import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createCommandGate, formatCooldownMessage } from "../src/command-gate.js";
import { handleTelegramCommand } from "../src/worker.js";

describe("createCommandGate", () => {
  test("allows the first command then blocks /open until cooldown", () => {
    let t = 1_000;
    const gate = createCommandGate({
      minIntervalMs: 2_000,
      openCooldownMs: 45_000,
      closeCooldownMs: 10_000,
      now: () => t,
    });
    assert.equal(gate.check("/open").ok, true);
    gate.mark("/open");
    t += 5_000;
    const hit = gate.check("/open");
    assert.equal(hit.ok, false);
    assert.equal(hit.waitSec, 40);
    t += 45_000;
    assert.equal(gate.check("/open").ok, true);
  });

  test("/close uses a shorter cooldown than /open", () => {
    let t = 1_000;
    const gate = createCommandGate({
      minIntervalMs: 2_000,
      openCooldownMs: 45_000,
      closeCooldownMs: 10_000,
      now: () => t,
    });
    gate.mark("/close");
    t += 5_000;
    assert.equal(gate.check("/close").ok, false);
    t += 6_000;
    assert.equal(gate.check("/close").ok, true);
  });

  test("/help is not gated by the worker", async () => {
    const sent = [];
    const gate = createCommandGate({ minIntervalMs: 60_000, now: () => 1 });
    gate.mark("/refresh");
    await handleTelegramCommand(
      { cmd: "/help", args: [], raw: "/help" },
      { client: {}, notifier: { send: async (msg) => sent.push(msg) }, commandGate: gate }
    );
    assert.equal(sent.length, 1);
    assert.match(sent[0], /Metina TPSL Bot Commands/);
  });
});

describe("telegram command anti-spam", () => {
  test("second /open is dropped before lookup", async () => {
    const sent = [];
    let lookups = 0;
    const token = "0x1111111111111111111111111111111111111111";
    const client = {
      lookup: async () => {
        lookups += 1;
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
          }],
        };
      },
    };
    const notifier = { send: async (msg) => sent.push(msg) };
    const gate = createCommandGate({
      minIntervalMs: 1,
      openCooldownMs: 45_000,
      now: () => 10_000,
    });
    const ctx = { client, notifier, inflight: new Set(), liveOpen: false, commandGate: gate };

    await handleTelegramCommand(
      { cmd: "/open", args: [token, "0.5", "robinhood"], raw: `/open ${token} 0.5 robinhood` },
      ctx,
    );
    await handleTelegramCommand(
      { cmd: "/open", args: [token, "0.5", "robinhood"], raw: `/open ${token} 0.5 robinhood` },
      ctx,
    );

    assert.equal(lookups, 1);
    assert.match(sent.join("\n"), /Terlalu cepat/);
    assert.match(formatCooldownMessage({ cmd: "/open", waitSec: 40 }), /\/open/);
  });
});
