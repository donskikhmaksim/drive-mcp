#!/usr/bin/env node
/**
 * Тест защиты исходящих запросов от SSRF (подделки запроса со стороны
 * сервера) — `src/safeFetch.ts`.
 *
 * Проверяются ВСЕ три рубежа, каждый — своим способом:
 *  [1][2] разбор адреса и классификация IP — чистая логика, без сети;
 *  [3] реальный сокет: локальный HTTP-сервер считает входящие запросы, и мы
 *      убеждаемся, что до него НЕ ДОШЛО НИ ОДНОГО — в том числе когда имя
 *      хоста «выглядит хорошо», а резолвится в 127.0.0.1 (DNS rebinding);
 *  [4] перенаправления: адрес из `Location` проходит те же проверки, и
 *      редирект на адрес метаданных облака обрывается ДО второго запроса.
 *
 * Сети наружу тест не требует: DNS-резолвер и транспорт инжектируются.
 *
 * Запуск: node scripts/test-ssrf-guard.mjs
 */
import http from "node:http";
import { Agent } from "undici";
import {
  assertAllowedGoogleUrl,
  isBlockedIp,
  safeGoogleFetch,
  createGuardedLookup,
  BlockedUrlError,
} from "../dist/safeFetch.js";

let failures = 0;
const check = (label, cond, extra = "") => {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${label}${cond ? "" : ` — got: ${extra}`}`);
  if (!cond) failures++;
};

/** Возвращает текст ошибки, если вызов бросил, иначе null. */
const throws = (fn) => {
  try {
    fn();
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
};

// ── 1. разбор адреса ────────────────────────────────────────────────────────

console.log("\n[1] assertAllowedGoogleUrl — что принимаем и что нет");

const ALLOWED = [
  "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=X",
  "https://storage.googleapis.com/upload/x",
  "https://lh3.googleusercontent.com/x",
];
for (const u of ALLOWED) {
  check(`принимает ${u.slice(0, 48)}…`, throws(() => assertAllowedGoogleUrl(u)) === null, String(throws(() => assertAllowedGoogleUrl(u))));
}

const BLOCKED = {
  "http://169.254.169.254/latest/meta-data/": "метаданные облака (AWS/GCP link-local)",
  "http://169.254.169.254/computeMetadata/v1/": "метаданные GCP",
  "http://metadata.google.internal/computeMetadata/v1/": "имя метаданных GCP",
  "https://metadata.google.internal/computeMetadata/v1/": "имя метаданных GCP по https",
  "http://localhost:8080/": "локальный хост",
  "http://127.0.0.1/": "loopback",
  "https://127.0.0.1/": "loopback по https",
  "http://[::1]/": "loopback IPv6",
  "https://[::1]/": "loopback IPv6 по https",
  "http://10.0.0.5/internal": "приватный диапазон 10/8",
  "https://192.168.1.1/": "приватный диапазон 192.168/16",
  "https://172.16.5.5/": "приватный диапазон 172.16/12",
  "http://www.googleapis.com/upload/x": "правильный хост, но http",
  "https://www.googleapis.com.evil.example/x": "похожий хост-подделка",
  "https://evil.example/?redir=https://www.googleapis.com": "чужой хост, Google только в query",
  "https://www.googleapis.com:8443/x": "нестандартный порт",
  "https://user:pass@www.googleapis.com/x": "встроенные учётные данные",
  "file:///etc/passwd": "локальный файл",
  "gopher://www.googleapis.com/": "чужая схема",
};
for (const [u, why] of Object.entries(BLOCKED)) {
  check(`отклоняет ${u.slice(0, 52)} (${why})`, throws(() => assertAllowedGoogleUrl(u)) !== null, "прошёл!");
}
check(
  "ошибка — это BlockedUrlError (отличима от сетевой)",
  (() => {
    try {
      assertAllowedGoogleUrl("http://127.0.0.1/");
      return false;
    } catch (e) {
      return e instanceof BlockedUrlError;
    }
  })(),
);

// ── 2. классификация IP ─────────────────────────────────────────────────────

console.log("\n[2] isBlockedIp — приватное/локальное/служебное против публичного");
const MUST_BLOCK = [
  "127.0.0.1", "127.1.2.3", "0.0.0.0", "10.1.2.3", "172.16.0.1", "172.31.255.255",
  "192.168.0.1", "169.254.169.254", "169.254.0.1", "100.64.0.1", "224.0.0.1",
  "255.255.255.255", "::1", "::", "fe80::1", "fc00::1", "fd00:ec2::254",
  "::ffff:127.0.0.1", "::ffff:169.254.169.254", "::ffff:7f00:1", "ff02::1",
];
for (const ip of MUST_BLOCK) check(`блокирует ${ip}`, isBlockedIp(ip) === true, "пропустил!");

const MUST_ALLOW = ["8.8.8.8", "142.250.72.14", "172.32.0.1", "100.128.0.1", "2607:f8b0:4005::200e"];
for (const ip of MUST_ALLOW) check(`пропускает публичный ${ip}`, isBlockedIp(ip) === false, "заблокировал");

// ── 3. реальный сокет: до локального сервера не должно дойти ────────────────

console.log("\n[3] реальное соединение: локальный сервер не должен получить НИ ОДНОГО запроса");

let hits = 0;
const local = http.createServer((_req, res) => {
  hits++;
  res.end("secret-from-internal-network");
});
await new Promise((r) => local.listen(0, "127.0.0.1", r));
const port = local.address().port;

// 3a. прямой адрес localhost — отсекается разбором адреса
hits = 0;
let err = null;
try {
  await safeGoogleFetch(`http://127.0.0.1:${port}/latest/meta-data/`);
} catch (e) {
  err = e;
}
check("прямой запрос на 127.0.0.1 отклонён", err instanceof BlockedUrlError, String(err));
check("локальный сервер не получил запроса", hits === 0, String(hits));

// 3b. DNS rebinding: хост из allowlist, но резолвится в 127.0.0.1.
// Проверяем на уровне РЕАЛЬНОГО соединения (undici connect), а не строки:
// именно это отличает «адрес выглядит хорошо» от «адрес, куда реально идём».
hits = 0;
const rebindLookup = (hostname, options, cb) => {
  const all = [{ address: "127.0.0.1", family: 4 }];
  if (options?.all) return cb(null, all, 0);
  return cb(null, all[0].address, 4);
};
const rebindAgent = new Agent({ connect: { lookup: createGuardedLookup(rebindLookup) } });
let rebindErr = null;
try {
  await fetch(`http://storage.googleapis.com:${port}/x`, { dispatcher: rebindAgent });
} catch (e) {
  rebindErr = e;
}
check("соединение при подмене DNS не состоялось", rebindErr !== null, "запрос прошёл!");
check("локальный сервер по-прежнему не получил запроса", hits === 0, String(hits));
check(
  "причина названа честно (закрытый адрес)",
  /закрытый адрес|BlockedUrlError/.test(String(rebindErr?.cause?.message ?? rebindErr?.message ?? "")),
  String(rebindErr?.cause?.message ?? rebindErr?.message),
);

// 3c. тот же guardedLookup пропускает публичный адрес (иначе проверка была бы
// просто «всё запрещено» и ничего не доказывала)
const publicLookup = (hostname, options, cb) => {
  const all = [{ address: "142.250.72.14", family: 4 }];
  if (options?.all) return cb(null, all, 0);
  return cb(null, all[0].address, 4);
};
const passed = await new Promise((resolve) => {
  createGuardedLookup(publicLookup)("storage.googleapis.com", { all: true }, (e) => resolve(!e));
});
check("публичный адрес guardedLookup пропускает", passed === true, "заблокировал публичный адрес");

local.close();

// ── 4. перенаправления ──────────────────────────────────────────────────────

console.log("\n[4] перенаправления проверяются, а не выполняются вслепую");

/** Заглушка транспорта: отдаёт заранее заданные ответы по очереди. */
function stubFetch(responses) {
  const seen = [];
  const impl = async (url) => {
    seen.push(String(url));
    const r = responses[seen.length - 1];
    if (!r) throw new Error(`неожиданный лишний запрос: ${url}`);
    return {
      status: r.status,
      ok: r.status >= 200 && r.status < 300,
      headers: { get: (k) => r.headers?.[k.toLowerCase()] ?? null },
      text: async () => r.body ?? "",
      json: async () => JSON.parse(r.body ?? "{}"),
    };
  };
  return { impl, seen };
}

const START = "https://www.googleapis.com/upload/drive/v3/files?upload_id=S1";

for (const [label, location] of [
  ["на метаданные облака", "http://169.254.169.254/latest/meta-data/"],
  ["на localhost", "http://127.0.0.1:1/"],
  ["на приватный диапазон", "http://10.0.0.7/internal"],
  ["на чужой хост", "https://evil.example/steal"],
]) {
  const { impl, seen } = stubFetch([{ status: 302, headers: { location } }]);
  let e = null;
  try {
    await safeGoogleFetch(START, { method: "PUT" }, { fetchImpl: impl });
  } catch (caught) {
    e = caught;
  }
  check(`редирект ${label} отклонён`, e instanceof BlockedUrlError, String(e));
  check(`редирект ${label}: второго запроса не было`, seen.length === 1, seen.join(" → "));
}

{
  // относительный Location на том же разрешённом хосте — можно идти дальше
  const { impl, seen } = stubFetch([
    { status: 302, headers: { location: "/upload/drive/v3/files?upload_id=S2" } },
    { status: 200, body: '{"id":"NEW"}' },
  ]);
  const res = await safeGoogleFetch(START, { method: "PUT" }, { fetchImpl: impl });
  check("редирект внутри googleapis.com выполняется", res.status === 200, String(res.status));
  check("второй запрос ушёл на разрешённый адрес", seen[1]?.startsWith("https://www.googleapis.com/"), seen.join(" → "));
}

{
  // 308 от Google — это «Resume Incomplete», а НЕ перенаправление
  const { impl, seen } = stubFetch([{ status: 308, headers: { range: "bytes=0-524287" } }]);
  const res = await safeGoogleFetch(START, { method: "PUT" }, { fetchImpl: impl });
  check("308 без Location отдаётся как есть (статус загрузки)", res.status === 308, String(res.status));
  check("308 не порождает второго запроса", seen.length === 1, seen.join(" → "));
}

{
  // цепочка редиректов не бесконечна
  const chain = Array.from({ length: 6 }, () => ({ status: 302, headers: { location: START } }));
  const { impl, seen } = stubFetch(chain);
  let e = null;
  try {
    await safeGoogleFetch(START, {}, { fetchImpl: impl, maxRedirects: 2 });
  } catch (caught) {
    e = caught;
  }
  check("цепочка редиректов обрывается по лимиту", e instanceof BlockedUrlError, String(e));
  check("лимит соблюдён (3 запроса при maxRedirects=2)", seen.length === 3, String(seen.length));
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
