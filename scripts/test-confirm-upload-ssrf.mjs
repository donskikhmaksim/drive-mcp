#!/usr/bin/env node
/**
 * SSRF-гейт `drive_confirm_upload` (mcp-development-standard
 * `references/security-checklist.md` §2 + §6).
 *
 * Дыра, которую закрывает проверяемый здесь фикс: `uploadUrl` приходит
 * АРГУМЕНТОМ от модели (`z.string()`, раньше без какой-либо валидации), а
 * сервер читает файлы владельца — то есть регулярно обрабатывает текст,
 * написанный посторонними, который может содержать инструкции для модели
 * («проверь загрузку по ссылке http://169.254.169.254/…»). Сервер делал по
 * этому адресу PUT со своей сетевой позиции внутри Railway, а тело ответа
 * возвращал модели через `errorBody(res)` — то есть это было не blind-SSRF,
 * а полноценное чтение внутренней сети.
 *
 * Тесты идут ЧЕРЕЗ ИНСТРУМЕНТ ЦЕЛИКОМ (настоящий MCP-сервер + InMemory
 * транспорт, как scripts/test-gate-coverage.mjs), а `fetch` подменён
 * счётчиком (как scripts/test-resumable.mjs) — так проверяется не только
 * текст отказа, но и главное: НИ ОДНОГО исходящего запроса.
 *
 * Usage: node scripts/test-confirm-upload-ssrf.mjs
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerDriveTools } from "../dist/tools/drive.js";
import { assertGoogleUploadUrl } from "../dist/tools/drive.js";

let failures = 0;
const check = (label, cond, extra = "") => {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${label}${cond ? "" : ` — got: ${extra}`}`);
  if (!cond) failures++;
};

// ── подменённый fetch со счётчиком и журналом ──────────────────────────────

const calls = [];
let responder = () => res({ status: 308, headers: { range: "bytes=0-9" } });

globalThis.fetch = async (url, init = {}) => {
  calls.push({ url: String(url), method: init.method, init });
  return responder(String(url), init);
};

/** Минимальный стенд-ин Response (тот же, что в test-resumable.mjs). */
function res({ status = 200, headers = {}, body = "" }) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    text: async () => body,
    json: async () => JSON.parse(body),
  };
}

const fakeClients = {
  names: ["personal"],
  defaultName: "personal",
  multi: false,
  resolve: () => ({
    docs: {},
    drive: { files: { get: async () => ({ data: {} }) } },
    accessToken: async () => "ya29.FAKE",
  }),
  baseGmailQuery: () => "",
};

const server = new McpServer({ name: "drive-ssrf-test", version: "0" });
registerDriveTools(server, fakeClients);
const client = new Client({ name: "c", version: "0" });
const [a, b] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(b), client.connect(a)]);

const callTool = async (name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);

const GOOD = "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=abc";

// ── [1] адреса, которые ОБЯЗАНЫ быть отклонены без единого запроса ─────────

console.log("\n[1] отказ + НИ ОДНОГО исходящего запроса (счётчик подменённого fetch = 0)");
const REJECTED = [
  ["обманка: allowlist-строка в ПУТИ чужого хоста", "https://evil.example.com/googleapis.com/upload"],
  ["обманка: allowlist-строка как ПРЕФИКС чужого домена", "https://googleapis.com.evil.com/upload/drive/v3/files"],
  ["обманка: дефис вместо точки", "https://evil-googleapis.com/upload/drive/v3/files"],
  ["http вместо https", "http://www.googleapis.com/upload/drive/v3/files"],
  ["loopback", "https://127.0.0.1/upload/drive/v3/files"],
  ["cloud-metadata Railway/AWS", "http://169.254.169.254/"],
  ["нестандартный порт", "https://www.googleapis.com:8080/upload/drive/v3/files"],
  ["логин:пароль в адресе", "https://user:pass@www.googleapis.com/upload/drive/v3/files"],
  ["верный хост, чужой путь", "https://www.googleapis.com/some/other/path"],
  ["вообще не URL", "не-урл-вовсе"],
];

for (const [label, url] of REJECTED) {
  calls.length = 0;
  const out = await callTool("drive_confirm_upload", { sessions: [{ uploadUrl: url }] });
  check(`${label} → 0 исходящих запросов`, calls.length === 0, `${calls.length} запрос(ов): ${JSON.stringify(calls.map((c) => c.url))}`);
  check(`${label} → отказ в ответе инструмента`, /🛑/.test(out.summary ?? "") && !!out.results?.[0]?.error, JSON.stringify(out).slice(0, 200));
  check(`${label} → нет статуса «completed/incomplete»`, out.results?.[0]?.status === undefined, String(out.results?.[0]?.status));
}

// ── [2] один плохой адрес в батче отменяет ВЕСЬ вызов (fail-closed) ────────

console.log("\n[2] плохой адрес рядом с хорошим — не отправляется НИЧЕГО (fail-closed на весь батч)");
calls.length = 0;
{
  const out = await callTool("drive_confirm_upload", {
    sessions: [{ uploadUrl: GOOD }, { uploadUrl: "http://169.254.169.254/" }],
  });
  check("0 исходящих запросов на весь батч", calls.length === 0, String(calls.length));
  check("оба элемента отмечены ошибкой", out.results.every((r) => !!r.error), JSON.stringify(out.results).slice(0, 200));
}

// ── [3] валидный адрес проходит и реально делает ровно один запрос ─────────

console.log("\n[3] валидный resumable-URI проходит (гейт не сломал штатный путь)");
calls.length = 0;
responder = () => res({ status: 308, headers: { range: "bytes=0-524287" } });
{
  const out = await callTool("drive_confirm_upload", { sessions: [{ uploadUrl: GOOD, sizeBytes: 1000000 }] });
  check("ровно один исходящий запрос", calls.length === 1, String(calls.length));
  check("это PUT по переданному адресу", calls[0]?.method === "PUT" && calls[0]?.url === GOOD, `${calls[0]?.method} ${calls[0]?.url}`);
  check("redirect: manual — за редиректом не ходим", calls[0]?.init?.redirect === "manual", String(calls[0]?.init?.redirect));
  check("таймаут выставлен (AbortSignal)", !!calls[0]?.init?.signal, String(calls[0]?.init?.signal));
  check("штатный 308 разобран как incomplete", out.results[0].status === "incomplete", JSON.stringify(out.results[0]));
  check("bytesReceived = последний байт + 1", out.results[0].bytesReceived === 524288, String(out.results[0].bytesReceived));
}

// ── [4] 308 остаётся штатным, а Location считается ошибкой ─────────────────

console.log("\n[4] 308 БЕЗ Location — штатный ответ; Location в ответе — ошибка, за редиректом не идём");
responder = () => res({ status: 308, headers: { location: "http://169.254.169.254/latest/meta-data/" } });
{
  const out = await callTool("drive_confirm_upload", { sessions: [{ uploadUrl: GOOD }] });
  check("редирект отклонён", /перенаправлением/.test(out.results[0].error ?? ""), JSON.stringify(out.results[0]));
  check("адрес редиректа НЕ пересказан наружу", !/169\.254\.169\.254/.test(JSON.stringify(out)), JSON.stringify(out).slice(0, 200));
  check("не выдал ложный incomplete", out.results[0].status === undefined, String(out.results[0].status));
}
responder = () => res({ status: 302, headers: { location: "https://www.googleapis.com/upload/drive/v3/files?x=1" } });
{
  const out = await callTool("drive_confirm_upload", { sessions: [{ uploadUrl: GOOD }] });
  check("302 с Location тоже отклонён (даже на разрешённый хост)", /перенаправлением/.test(out.results[0].error ?? ""), JSON.stringify(out.results[0]));
}
responder = () => res({ status: 200, body: JSON.stringify({ id: "NEWID", name: "x.bin", webViewLink: "https://drive/NEWID" }) });
{
  const out = await callTool("drive_confirm_upload", { sessions: [{ uploadUrl: GOOD }] });
  check("200 (загрузка завершена) по-прежнему разбирается", out.results[0].status === "completed" && out.results[0].fileId === "NEWID", JSON.stringify(out.results[0]));
}
responder = () => res({ status: 410, body: "gone" });
{
  const out = await callTool("drive_confirm_upload", { sessions: [{ uploadUrl: GOOD }] });
  check("410 → expired (ветка не сломана)", out.results[0].status === "expired", JSON.stringify(out.results[0]));
}

// ── [5] тело ответа НЕ утекает в результат инструмента ────────────────────

console.log("\n[5] не-утечка: тело ответа Google наружу не пересказывается, статус — да");
responder = () => res({ status: 500, body: "SUPER-SECRET-INTERNAL-BODY" });
{
  const out = await callTool("drive_confirm_upload", { sessions: [{ uploadUrl: GOOD }] });
  const whole = JSON.stringify(out);
  check("тела ответа в результате НЕТ", !whole.includes("SUPER-SECRET-INTERNAL-BODY"), whole.slice(0, 200));
  check("HTTP-статус 500 упомянут", /500/.test(out.results[0].error ?? ""), JSON.stringify(out.results[0]));
}

// ── [6] сам хелпер: точечные проверки разбора URL ─────────────────────────

console.log("\n[6] assertGoogleUploadUrl — точечные проверки (никаких проверок по подстроке)");
const throws = (url) => {
  try {
    assertGoogleUploadUrl(url);
    return false;
  } catch {
    return true;
  }
};
check("www.googleapis.com проходит", !throws(GOOD));
check("googleapis.com (без www) проходит", !throws("https://googleapis.com/upload/drive/v3/files?uploadType=resumable"));
check("поддомен *.googleapis.com проходит", !throws("https://storage.googleapis.com/upload/drive/v3/files"));
check("завершающая точка в хосте проходит", !throws("https://www.googleapis.com./upload/drive/v3/files"));
check("явный порт 443 проходит", !throws("https://www.googleapis.com:443/upload/drive/v3/files"));
check("подпуть эндпоинта (замена файла) проходит", !throws("https://www.googleapis.com/upload/drive/v3/files/FILEID?uploadType=resumable"));
check("похожий, но чужой путь отклонён", throws("https://www.googleapis.com/upload/drive/v3/filesEVIL"));
check("file:// отклонён", throws("file:///etc/passwd"));
check("относительный путь отклонён", throws("/upload/drive/v3/files"));

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
