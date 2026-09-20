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

export function createClient({ metinaUrl, email, password, evmKey, address, rpcs }) {
  let cookie = "";

  function headers({ sign = false } = {}) {
    const h = { Accept: "application/json" };
    if (cookie) h.Cookie = cookie;
    if (address) h["x-metina-evm-address"] = address;
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
      const qs = new URLSearchParams();
      qs.set("discover", discover ? "1" : "0");
      qs.set("hydrate", hydrate ? "1" : "0");
      const res = await fetch(`${metinaUrl}/api/web/positions?${qs}`, {
        headers: headers(),
      });
      return readJson(res);
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
