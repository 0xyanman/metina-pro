import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createClient, mergePositionLegs } from "../src/metina-client.js";

const creds = {
  metinaUrl: "https://pro.metina.id",
  email: "member@example.com",
  password: "secret",
  evmKey: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  address: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  rpcs: { bsc: "https://bsc.example" },
};

function jsonRes({ status = 200, body = { ok: true }, cookies = [] } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      getSetCookie: () => cookies,
      get: (name) => (String(name).toLowerCase() === "set-cookie" ? cookies[0] || null : null),
    },
    async json() {
      return body;
    },
  };
}

async function withFetch(handler, fn) {
  const prev = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return handler(url, init, calls.length);
  };
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = prev;
  }
}

describe("Metina client", () => {
  test("login stores the session cookie", async () => {
    const client = createClient(creds);
    await withFetch(() => jsonRes({
      body: { ok: true, authed: true },
      cookies: ["metina_member_session=abc.member1; Path=/; HttpOnly"],
    }), async (calls) => {
      const out = await client.login();
      assert.equal(out.authed, true);
      assert.equal(calls.length, 1);
      assert.match(calls[0].url, /\/api\/auth\/login$/);
      const sent = JSON.parse(calls[0].init.body);
      assert.equal(sent.email, creds.email);
      assert.equal(sent.password, creds.password);
    });
  });

  test("login without a cookie throws", async () => {
    const client = createClient(creds);
    await withFetch(() => jsonRes({ body: { ok: true } }), async () => {
      await assert.rejects(() => client.login(), /no session cookie/);
    });
  });

  test("positions after 401 logs in again then retries", async () => {
    const client = createClient(creds);
    await withFetch((_url, _init, n) => {
      if (n === 1) return jsonRes({ status: 401, body: { ok: false, error: "Unauthorized" } });
      if (n === 2) {
        return jsonRes({
          body: { ok: true, authed: true },
          cookies: ["metina_member_session=fresh.member1; Path=/"],
        });
      }
      return jsonRes({ body: { ok: true, positions: [{ position: "9" }] } });
    }, async (calls) => {
      const out = await client.positions({ discover: true });
      assert.equal(out.positions[0].position, "9");
      assert.equal(calls.length, 3);
      assert.match(calls[0].url, /\/api\/web\/positions\?discover=1&include_solana=0&hydrate=1$/);
      assert.match(calls[1].url, /\/api\/auth\/login$/);
      assert.match(calls[2].url, /\/api\/web\/positions/);
      assert.equal(calls[2].init.headers.Cookie, "metina_member_session=fresh.member1");
      assert.equal(calls[2].init.headers["x-metina-evm-address"], creds.address);
    });
  });

  test("positions can request a lite indexer pass", async () => {
    const client = createClient(creds);
    await withFetch((_url, _init, n) => {
      if (n === 1) {
        return jsonRes({
          body: { ok: true, authed: true },
          cookies: ["metina_member_session=abc.member1"],
        });
      }
      return jsonRes({ body: { ok: true, positions: [] } });
    }, async (calls) => {
      await client.login();
      await client.positions({ discover: false, hydrate: false });
      assert.match(calls[1].url, /\/api\/web\/positions\?discover=0&include_solana=0&hydrate=0$/);
    });
  });

  test("close sends _vault key only in the body", async () => {
    const client = createClient(creds);
    await withFetch((_url, _init, n) => {
      if (n === 1) {
        return jsonRes({
          body: { ok: true },
          cookies: ["metina_member_session=abc.member1"],
        });
      }
      return jsonRes({ body: { ok: true, success: true, tx: "0xclose" } });
    }, async (calls) => {
      await client.login();
      const out = await client.close({
        venue: "uniswap",
        position: "42",
        swap: true,
        kind: "stop_loss",
      });
      assert.equal(out.tx, "0xclose");
      const sent = JSON.parse(calls[1].init.body);
      assert.equal(sent._vault.evmKey, creds.evmKey);
      assert.equal(sent.kind, "stop_loss");
      assert.equal(JSON.stringify(calls[0].init.body || {}).includes(creds.evmKey), false);
      assert.equal(JSON.stringify(calls[1].init.headers).includes(creds.evmKey), false);
    });
  });

  test("lookup posts to /api/web/lookup without a vault key", async () => {
    const client = createClient(creds);
    await withFetch((_url, _init, n) => {
      if (n === 1) {
        return jsonRes({
          body: { ok: true },
          cookies: ["metina_member_session=abc.member1"],
        });
      }
      return jsonRes({ body: { ok: true, type: "uniswap", pools: [] } });
    }, async (calls) => {
      await client.login();
      const out = await client.lookup({ token: creds.address, chain: "robinhood", amount: 0.5 });
      assert.equal(out.type, "uniswap");
      assert.match(calls[1].url, /\/api\/web\/lookup$/);
      const sent = JSON.parse(calls[1].init.body);
      assert.equal(sent._vault, undefined);
      assert.equal(sent.token, creds.address);
    });
  });

  test("deploy sends _vault key only in the body", async () => {
    const client = createClient(creds);
    await withFetch((_url, _init, n) => {
      if (n === 1) {
        return jsonRes({
          body: { ok: true },
          cookies: ["metina_member_session=abc.member1"],
        });
      }
      return jsonRes({ body: { ok: true, success: true, tx: "0xopen", position: "42" } });
    }, async (calls) => {
      await client.login();
      const out = await client.deploy({
        venue: "uniswap",
        pool: "0x2222222222222222222222222222222222222222",
        amount: 0.5,
        chain: "robinhood",
      });
      assert.equal(out.tx, "0xopen");
      assert.match(calls[1].url, /\/api\/web\/deploy$/);
      const sent = JSON.parse(calls[1].init.body);
      assert.equal(sent._vault.evmKey, creds.evmKey);
      assert.equal(sent.venue, "uniswap");
      assert.equal(JSON.stringify(calls[1].init.headers).includes(creds.evmKey), false);
    });
  });

  test("positions fetch the desk EVM snap, not the combined include_solana default", async () => {
    const client = createClient({ ...creds, solanaAddress: "So11111111111111111111111111111111111111112" });
    await withFetch((_url, _init, n) => {
      if (n === 1) {
        return jsonRes({
          body: { ok: true, authed: true },
          cookies: ["metina_member_session=abc.member1"],
        });
      }
      if (String(_url).includes("chain=solana")) {
        return jsonRes({ body: { ok: true, positions: [{ position: "sol-1" }] } });
      }
      return jsonRes({ body: { ok: true, positions: [{ position: "evm-1" }] } });
    }, async (calls) => {
      await client.login();
      const out = await client.positions({ discover: true, hydrate: true });
      assert.deepEqual(out.positions.map((p) => p.position), ["evm-1", "sol-1"]);
      assert.match(calls[1].url, /include_solana=0/);
      assert.match(calls[2].url, /chain=solana/);
      assert.equal(calls[2].init.headers["x-metina-solana-address"], "So11111111111111111111111111111111111111112");
    });
  });

  test("mergePositionLegs keeps pending only when both legs are empty pending", () => {
    const pending = mergePositionLegs({ ok: true, pending: true, positions: [] }, null);
    assert.equal(pending.pending, true);
    assert.equal(pending.positions.length, 0);
    const ready = mergePositionLegs({ ok: true, pending: true, positions: [] }, { ok: true, positions: [{ position: "1" }] });
    assert.equal(ready.pending, false);
    assert.equal(ready.positions[0].position, "1");
  });

  test("non-401 errors do not retry login", async () => {
    const client = createClient(creds);
    await withFetch(() => jsonRes({ status: 500, body: { ok: false, error: "boom" } }), async (calls) => {
      await assert.rejects(() => client.positions(), /boom/);
      assert.equal(calls.length, 1);
    });
  });
});
