import { privateKeyToAccount } from "viem/accounts";

function envStr(name, fallback = "") {
  return String(process.env[name] ?? fallback).trim();
}

function envNum(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function envOn(name, fallback = false) {
  const v = envStr(name).toLowerCase();
  if (!v) return fallback;
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function normalizePk(raw) {
  const hex = String(raw || "").trim();
  if (!hex) return "";
  return hex.startsWith("0x") ? hex : `0x${hex}`;
}

function parseThreadId(raw) {
  if (!raw) return null;
  const num = Number(raw);
  return Number.isFinite(num) ? num : raw;
}

export function loadConfig() {
  const metinaUrl = envStr("METINA_URL", "https://pro.metina.id").replace(/\/+$/, "");
  const email = envStr("METINA_EMAIL");
  const password = envStr("METINA_PASSWORD");
  const evmKey = normalizePk(envStr("EVM_PRIVATE_KEY"));
  if (!email || !password) {
    throw new Error("Set METINA_EMAIL and METINA_PASSWORD in .env");
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(evmKey)) {
    throw new Error("Set EVM_PRIVATE_KEY in .env (0x + 64 hex chars)");
  }
  const address = privateKeyToAccount(evmKey).address;
  const rpcs = {};
  for (const [envName, chain] of [
    ["RPC_ROBINHOOD", "robinhood"],
    ["RPC_BASE", "base"],
    ["RPC_BSC", "bsc"],
    ["RPC_ETHEREUM", "ethereum"],
  ]) {
    const url = envStr(envName);
    if (url) rpcs[chain] = url;
  }
  if (!Object.keys(rpcs).length) {
    throw new Error("Set at least one of RPC_ROBINHOOD, RPC_BASE, RPC_BSC in .env (same URLs as Settings)");
  }
  const tgToken = envStr("TELEGRAM_BOT_TOKEN");
  const tgChatId = envStr("TELEGRAM_CHAT_ID");
  const tgThreadId = parseThreadId(envStr("TELEGRAM_MESSAGE_THREAD_ID"));
  const tgEnabled = envOn("TELEGRAM_ENABLED", true);

  const telegram = tgToken && tgChatId
    ? {
      token: tgToken,
      chatId: tgChatId,
      threadId: tgThreadId,
      enabled: tgEnabled,
    }
    : null;

  return {
    metinaUrl,
    email,
    password,
    evmKey,
    address,
    rpcs,
    pollMs: Math.max(15_000, envNum("POLL_MS", 45_000)),
    discoverEvery: Math.max(1, Math.round(envNum("DISCOVER_EVERY", 8))),
    liveClose: envOn("LIVE_CLOSE", false),
    liveOpen: envOn("LIVE_OPEN", false),
    telegramCmdIntervalMs: Math.max(500, envNum("TELEGRAM_CMD_INTERVAL_MS", 2_000)),
    telegramOpenCooldownMs: Math.max(5_000, envNum("TELEGRAM_OPEN_COOLDOWN_MS", 45_000)),
    telegramCloseCooldownMs: Math.max(2_000, envNum("TELEGRAM_CLOSE_COOLDOWN_MS", 10_000)),
    telegram,
  };
}

