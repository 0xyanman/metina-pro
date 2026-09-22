function parseSetCookie(res) {
  const raw = typeof res.headers.getSetCookie === "function"
    ? res.headers.getSetCookie()
    : [res.headers.get("set-cookie")].filter(Boolean);
  const jar = [];
  for (const line of raw) {
    const part = String(line || "").split(";")[0].trim();
    if (part && !part.endsWith("=")) jar.push(part);
  }
  return jar.join("; ");
}

function mergeCookie(prev, next) {
  const map = new Map();
  for (const chunk of [prev, next]) {
    for (const part of String(chunk || "").split(";")) {
      const piece = part.trim();
      const i = piece.indexOf("=");
      if (i <= 0) continue;
      map.set(piece.slice(0, i), piece.slice(i + 1));
    }
  }
  return [...map.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

export function mergePositionLegs(evm, sol) {
  const evmList = Array.isArray(evm?.positions) ? evm.positions : [];
  const solList = Array.isArray(sol?.positions) ? sol.positions : [];
  const evmPending = Boolean(evm?.pending) && evmList.length === 0;
  const solPending = sol ? Boolean(sol.pending) && solList.length === 0 : false;
  const errors = [
    ...(Array.isArray(evm?.errors) ? evm.errors : []),
    ...(Array.isArray(sol?.errors) ? sol.errors : []),
  ];
  return {
    ok: evm?.ok !== false && (!sol || sol.ok !== false),
    pending: evmPending && (!sol || solPending),
    positions: [...evmList, ...solList],
    errors,
    wallet: evm?.wallet || sol?.wallet || undefined,
  };
}

export function createClient({ metinaUrl, email, password, evmKey, address, solanaAddress, rpcs }) {
  let cookie = "";

  function headers({ sign = false } = {}) {
    const h = { Accept: "application/json" };
    if (cookie) h.Cookie = cookie;
    if (address) h["x-metina-evm-address"] = address;
    if (solanaAddress) h["x-metina-solana-address"] = solanaAddress;
    if (rpcs && Object.keys(rpcs).length) h["x-metina-rpcs"] = JSON.stringify(rpcs);
    if (sign) h["Content-Type"] = "application/json";
    return h;
  }

  async function readJson(res) {
    const next = parseSetCookie(res);
    if (next) cookie = mergeCookie(cookie, next);
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.ok === false) {
      const err = new Error(json.error || json.message || `HTTP ${res.status}`);
      err.status = res.status;
      err.body = json;
      throw err;
    }
    return json;
  }

  async function login() {
    const res = await fetch(`${metinaUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const json = await readJson(res);
    if (!cookie) throw new Error("Login ok but no session cookie");
    return json;
  }

  async function withAuth(fn) {
    try {
      return await fn();
    } catch (err) {
      if (err.status !== 401) throw err;
      await login();
      return fn();
    }
  }

  async function positions({ discover = false, hydrate = true } = {}) {
    return withAuth(async () => {
      // Same legs as the desk Open tab. include_solana=0 is the EVM snap the
      // website writes; omitting it defaults to s1 and Telegram sees [].
      const evmQs = new URLSearchParams();
      evmQs.set("discover", discover ? "1" : "0");
      evmQs.set("include_solana", "0");
      evmQs.set("hydrate", hydrate ? "1" : "0");
      const evmRes = await fetch(`${metinaUrl}/api/web/positions?${evmQs}`, {
        headers: headers(),
      });
      const evm = await readJson(evmRes);
      if (!solanaAddress) return mergePositionLegs(evm, null);
      const solQs = new URLSearchParams();
      solQs.set("chain", "solana");
      solQs.set("hydrate", hydrate ? "1" : "0");
      const solRes = await fetch(`${metinaUrl}/api/web/positions?${solQs}`, {
        headers: headers(),
      });
      return mergePositionLegs(evm, await readJson(solRes));
    });
  }

  async function close(body) {
    return withAuth(async () => {
      const res = await fetch(`${metinaUrl}/api/web/close`, {
        method: "POST",
        headers: headers({ sign: true }),
        body: JSON.stringify({
          ...body,
          _vault: { evmKey },
        }),
      });
      return readJson(res);
    });
  }

  async function lookup(body) {
    return withAuth(async () => {
      const res = await fetch(`${metinaUrl}/api/web/lookup`, {
        method: "POST",
        headers: headers({ sign: true }),
        body: JSON.stringify(body),
      });
      return readJson(res);
    });
  }

  async function deploy(body) {
    return withAuth(async () => {
      const res = await fetch(`${metinaUrl}/api/web/deploy`, {
        method: "POST",
        headers: headers({ sign: true }),
        body: JSON.stringify({
          ...body,
          _vault: { evmKey },
        }),
      });
      return readJson(res);
    });
  }

  return { login, positions, close, lookup, deploy };
}
