import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";

const ENV_KEYS = [
  "METINA_URL",
  "METINA_EMAIL",
  "METINA_PASSWORD",
  "EVM_PRIVATE_KEY",
  "RPC_BSC",
  "RPC_BASE",
  "RPC_ROBINHOOD",
  "RPC_ETHEREUM",
  "POLL_MS",
  "DISCOVER_EVERY",
  "HYDRATE_EVERY",
  "LIVE_CLOSE",
  "LIVE_OPEN",
  "TELEGRAM_CMD_INTERVAL_MS",
  "TELEGRAM_OPEN_COOLDOWN_MS",
  "TELEGRAM_CLOSE_COOLDOWN_MS",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
  "TELEGRAM_MESSAGE_THREAD_ID",
  "TELEGRAM_ENABLED",
];

/** Anvil account #1 — public test key, never a real wallet. */
const TEST_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const TEST_ADDR = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

function withEnv(patch, fn) {
  const prev = {};
  for (const key of ENV_KEYS) {
    prev[key] = process.env[key];
    if (Object.prototype.hasOwnProperty.call(patch, key)) process.env[key] = patch[key];
    else delete process.env[key];
  }
  try {
    return fn();
  } finally {
    for (const key of ENV_KEYS) {
      if (prev[key] === undefined) delete process.env[key];
      else process.env[key] = prev[key];
    }
  }
}

const valid = {
  METINA_EMAIL: "member@example.com",
  METINA_PASSWORD: "secret",
  EVM_PRIVATE_KEY: TEST_KEY,
  RPC_BSC: "https://bsc.example",
};

describe("loadConfig", () => {
  test("rejects missing email or password", () => {
    withEnv({ EVM_PRIVATE_KEY: TEST_KEY }, () => {
      assert.throws(() => loadConfig(), /METINA_EMAIL and METINA_PASSWORD/);
    });
    withEnv({ METINA_EMAIL: "a@b.com", EVM_PRIVATE_KEY: TEST_KEY }, () => {
      assert.throws(() => loadConfig(), /METINA_EMAIL and METINA_PASSWORD/);
    });
  });

  test("rejects missing RPCs", () => {
    withEnv({
      METINA_EMAIL: "member@example.com",
      METINA_PASSWORD: "secret",
      EVM_PRIVATE_KEY: TEST_KEY,
    }, () => {
      assert.throws(() => loadConfig(), /RPC_ROBINHOOD, RPC_BASE, RPC_BSC/);
    });
  });

  test("rejects a bad private key", () => {
    withEnv({ ...valid, EVM_PRIVATE_KEY: "0xnotakey" }, () => {
      assert.throws(() => loadConfig(), /EVM_PRIVATE_KEY/);
    });
    withEnv({ ...valid, EVM_PRIVATE_KEY: "" }, () => {
      assert.throws(() => loadConfig(), /EVM_PRIVATE_KEY/);
    });
  });

  test("accepts key without 0x and derives the address", () => {
    const cfg = withEnv({ ...valid, EVM_PRIVATE_KEY: TEST_KEY.slice(2) }, () => loadConfig());
    assert.equal(cfg.evmKey, TEST_KEY);
    assert.equal(cfg.address.toLowerCase(), TEST_ADDR.toLowerCase());
  });

  test("defaults and LIVE_CLOSE stay off unless set", () => {
    const cfg = withEnv(valid, () => loadConfig());
    assert.equal(cfg.metinaUrl, "https://pro.metina.id");
    assert.equal(cfg.liveClose, false);
    assert.equal(cfg.liveOpen, false);
    assert.equal(cfg.pollMs, 45_000);
    assert.equal(cfg.telegramCmdIntervalMs, 2_000);
    assert.equal(cfg.telegramOpenCooldownMs, 45_000);
    assert.equal(cfg.telegramCloseCooldownMs, 10_000);
    assert.equal(cfg.discoverEvery, 27);
    assert.equal(cfg.hydrateEvery, 4);
    assert.equal(cfg.telegram, null);
  });

  test("strips trailing slash, maps RPCs, and turns LIVE_CLOSE on", () => {
    const cfg = withEnv({
      ...valid,
      METINA_URL: "https://pro.metina.id/",
      RPC_BSC: "https://bsc.example",
      RPC_BASE: "https://base.example",
      LIVE_CLOSE: "1",
      LIVE_OPEN: "1",
      POLL_MS: "10000",
    }, () => loadConfig());
    assert.equal(cfg.metinaUrl, "https://pro.metina.id");
    assert.equal(cfg.rpcs.bsc, "https://bsc.example");
    assert.equal(cfg.rpcs.base, "https://base.example");
    assert.equal(cfg.liveClose, true);
    assert.equal(cfg.liveOpen, true);
    assert.equal(cfg.pollMs, 15_000);
    assert.equal(cfg.discoverEvery, 80);
    assert.equal(cfg.hydrateEvery, 12);
  });

  test("DISCOVER_EVERY and HYDRATE_EVERY env override the computed cadence", () => {
    const cfg = withEnv({
      ...valid,
      DISCOVER_EVERY: "8",
      HYDRATE_EVERY: "2",
    }, () => loadConfig());
    assert.equal(cfg.discoverEvery, 8);
    assert.equal(cfg.hydrateEvery, 2);
  });

  test("parses Telegram config when token and chat_id are present", () => {
    const cfg = withEnv({
      ...valid,
      TELEGRAM_BOT_TOKEN: "123456:ABC-DEF",
      TELEGRAM_CHAT_ID: "-1001234567890",
      TELEGRAM_MESSAGE_THREAD_ID: "42",
      TELEGRAM_ENABLED: "1",
    }, () => loadConfig());
    assert.deepEqual(cfg.telegram, {
      token: "123456:ABC-DEF",
      chatId: "-1001234567890",
      threadId: 42,
      enabled: true,
    });
  });

  test("disables Telegram when TELEGRAM_ENABLED is 0 or false", () => {
    const cfg = withEnv({
      ...valid,
      TELEGRAM_BOT_TOKEN: "123456:ABC-DEF",
      TELEGRAM_CHAT_ID: "-1001234567890",
      TELEGRAM_ENABLED: "0",
    }, () => loadConfig());
    assert.equal(cfg.telegram.enabled, false);
  });

  test("leaves telegram as null if token or chat_id is missing", () => {
    const cfgOnlyToken = withEnv({
      ...valid,
      TELEGRAM_BOT_TOKEN: "123456:ABC-DEF",
    }, () => loadConfig());
    assert.equal(cfgOnlyToken.telegram, null);

    const cfgOnlyChatId = withEnv({
      ...valid,
      TELEGRAM_CHAT_ID: "-1001234567890",
    }, () => loadConfig());
    assert.equal(cfgOnlyChatId.telegram, null);
  });
});

