import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { shouldFetchOpenInventory, ticksForInterval } from "../src/open-fetch.js";

describe("open fetch cadence", () => {
  test("ticksForInterval maps 20 min and 3 min at a 45s poll", () => {
    assert.equal(ticksForInterval(20 * 60_000, 45_000), 27);
    assert.equal(ticksForInterval(3 * 60_000, 45_000), 4);
  });

  test("first tick and pending full sync always hydrate + discover", () => {
    assert.deepEqual(shouldFetchOpenInventory(1), { discover: true, hydrate: true });
    assert.deepEqual(shouldFetchOpenInventory(3, { pendingFullSync: true }), { discover: true, hydrate: true });
  });

  test("regular ticks stay lite until hydrate or discover cadence", () => {
    assert.deepEqual(
      shouldFetchOpenInventory(2, { discoverEvery: 27, hydrateEvery: 4 }),
      { discover: false, hydrate: false },
    );
    assert.deepEqual(
      shouldFetchOpenInventory(4, { discoverEvery: 27, hydrateEvery: 4 }),
      { discover: false, hydrate: true },
    );
    assert.deepEqual(
      shouldFetchOpenInventory(27, { discoverEvery: 27, hydrateEvery: 4 }),
      { discover: true, hydrate: true },
    );
  });
});
