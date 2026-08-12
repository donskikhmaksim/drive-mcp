#!/usr/bin/env node
/**
 * Тест автосправочника гейтированных методов (`TZ_automation_key_method_
 * catalog.md`, backend-часть — разделы 1-4). Покрывает тестовый план п.1-5
 * (drive-mcp несёт п.6 не относится — это только gmail-mcp хаб).
 *
 * Node ≥ 22.18 грузит .ts напрямую (тот же приём, что и test-consent.mjs) —
 * билд не нужен для чистой логики (`scopeCovers`), но для e2e-сценариев с
 * реальным `McpServer`/HTTP используется `../dist/...` (тот же приём, что и
 * test-drive-gate.mjs) — запусти `npm run build` перед этим файлом (делает
 * `npm test`).
 *
 * Usage: node scripts/test-automation-key-catalog.mjs
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { scopeCovers, checkAutomationKey, AUTOMATION_SERVICE } from "../dist/automationKey.js";
import { listGatedTools } from "../dist/gated_tools_catalog.js";
import { AUTOMATION_KEY_DOC } from "../dist/consent.js";
import { registerDriveTools } from "../dist/tools/drive.js";
import { registerAccountTools } from "../dist/accounts.js";
import { startHttpServer } from "../dist/http.js";

let failures = 0;
const check = (label, cond, extra = "") => {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${label}${cond ? "" : ` — got: ${extra}`}`);
  if (!cond) failures++;
};

// ── [1] listGatedTools — gated tool included, non-gated tool excluded ───────
console.log("\n[1] listGatedTools: только тулы с automation_key в схеме");
{
  const server = new McpServer({ name: "catalog-unit-test", version: "0" });
  server.registerTool(
    "fake_gated_tool",
    {
      title: "Fake gated",
      description: "A fake gated tool for the catalog unit test.",
      inputSchema: { automation_key: z.string().optional().describe(AUTOMATION_KEY_DOC) },
    },
    async () => ({ content: [{ type: "text", text: "ok" }] }),
  );
  server.registerTool(
    "fake_readonly_tool",
    {
      title: "Fake read-only",
      description: "A fake NON-gated tool, no automation_key.",
      inputSchema: { query: z.string().optional() },
    },
    async () => ({ content: [{ type: "text", text: "ok" }] }),
  );
  const tools = await listGatedTools(server);
  check("ровно 1 тул в каталоге", tools.length === 1, JSON.stringify(tools));
  check("это гейтированный тул", tools[0]?.name === "fake_gated_tool", JSON.stringify(tools));
  check("негейтированный тул отсутствует", !tools.some((t) => t.name === "fake_readonly_tool"));
}

// ── [1b] listGatedTools против реального набора drive-тулов ─────────────────
console.log("\n[1b] listGatedTools: реальный registerDriveTools — все 10 гейтированных найдены, ungated (drive_search и т.п.) нет");
{
  const clients = {
    names: ["personal"],
    defaultName: "personal",
    multi: false,
    resolve: () => ({ drive: {}, docs: {}, accessToken: async () => "ya29.FAKE" }),
    baseGmailQuery: () => "",
  };
  const consentCtx = {
    consentStore: null,
    consentCfg: { server: "drive", consentTtlMs: 3_600_000, minConsentGapMs: 0, sendBatchMax: 10 },
    auditStore: null,
    checkAutomationKey: async () => ({ ok: false }),
  };
  const server = new McpServer({ name: "catalog-drive-real", version: "0" });
  registerAccountTools(server, clients);
  registerDriveTools(server, clients, consentCtx);
  const tools = await listGatedTools(server);
  const names = tools.map((t) => t.name).sort();
  const expected = [
    "drive_create_folder",
    "drive_create_upload_session",
    "drive_get_download_url",
    "drive_move",
    "drive_overwrite_file",
    "drive_rename",
    "drive_share",
    "drive_trash",
    "drive_unshare",
    "drive_upload_file",
  ].sort();
  check("ровно ожидаемые 10 гейтированных drive_* тулов", JSON.stringify(names) === JSON.stringify(expected), JSON.stringify(names));
  check("ungated drive_search отсутствует", !names.includes("drive_search"));
  check("account tool (list_accounts и т.п.) отсутствует", !names.some((n) => n.includes("account")));
  check("каждый элемент несёт непустое description", tools.every((t) => typeof t.description === "string" && t.description.length > 0));
}

// ── [3] scopeCovers — точные токены, без подстрок/startsWith ────────────────
console.log("\n[3] scopeCovers: новые кейсы service:tool");
{
  check("'all' покрывает всё", scopeCovers("all", "drive", "drive_trash"));
  check("bare service покрывает ЛЮБОЙ метод (обратная совместимость)", scopeCovers("drive", "drive", "drive_trash"));
  check("bare service покрывает другой метод того же сервиса", scopeCovers("drive", "drive", "drive_share"));
  check("service:tool матчит точно этот метод", scopeCovers("drive:drive_trash", "drive", "drive_trash"));
  check("service:tool НЕ матчит другой метод того же сервиса", !scopeCovers("drive:drive_trash", "drive", "drive_share"));
  check(
    "общий префикс без ':' не матчит (drive:drive_send vs drive:drive_send_extra)",
    !scopeCovers("drive:drive_send", "drive", "drive_send_extra"),
  );
  check(
    "gmail:gmail_send НЕ матчит gmail:gmail_send_all (общий префикс, тест из ТЗ)",
    !scopeCovers("gmail:gmail_send", "gmail", "gmail_send_all"),
  );
  check("другой service вообще не матчит", !scopeCovers("gmail:gmail_send", "drive", "drive_trash"));
  check("google-sheets НЕ матчит sheets (регресс старого теста)", !scopeCovers("google-sheets", "sheets", "anything"));
  check("CSV из нескольких токенов — матчит нужный", scopeCovers("gmail,drive:drive_trash", "drive", "drive_trash"));
  check("CSV из нескольких токенов — НЕ матчит непере численный", !scopeCovers("gmail,drive:drive_trash", "drive", "drive_share"));
  check("пустая строка не матчит ничего", !scopeCovers("", "drive", "drive_trash"));
}

// ── [4]/[5] checkAutomationKey(key, tool) — fail-safe без БД ────────────────
console.log("\n[4] checkAutomationKey: без сконфигурированного Postgres — тихий fail-safe {ok:false}, не бросает");
{
  const result = await checkAutomationKey("some-raw-key", "drive_trash");
  check("ok:false (fail-safe, не падает)", result.ok === false, JSON.stringify(result));
  check("AUTOMATION_SERVICE === 'drive'", AUTOMATION_SERVICE === "drive");
}

// ── [4b] Прокидка tool сквозь requireConsent → checkAutomationKey (реальные тулы) ──
console.log("\n[4b] requireConsent прокидывает ИМЯ ВЫЗЫВАЕМОГО тула в checkAutomationKey — метод-specific scope реально разграничивает drive_trash vs drive_share");
{
  const { McpServer: McpServer2 } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

  const world = {
    files: new Map([["F1", { id: "F1", name: "report.pdf", mimeType: "application/pdf", parents: ["ROOT"], trashed: false, md5Checksum: "hash-v1", modifiedTime: "2026-01-01T00:00:00Z", size: "100" }]]),
    permissions: new Map([["F1", []]]),
  };
  const clients = {
    names: ["personal"],
    defaultName: "personal",
    multi: false,
    resolve: () => ({
      drive: {
        files: {
          get: async ({ fileId }) => {
            const f = world.files.get(fileId);
            if (!f) throw new Error("not found");
            return { data: { ...f } };
          },
          update: async ({ fileId, requestBody }) => {
            const f = world.files.get(fileId);
            if (requestBody?.trashed !== undefined) f.trashed = requestBody.trashed;
            f.md5Checksum = "hash-updated";
            f.modifiedTime = new Date().toISOString();
            return { data: { id: f.id, name: f.name, parents: f.parents, trashed: f.trashed } };
          },
        },
        permissions: {
          list: async ({ fileId }) => ({ data: { permissions: world.permissions.get(fileId) ?? [] } }),
          create: async ({ fileId, requestBody }) => {
            const id = "PERM1";
            const perm = { id, type: requestBody.type, role: requestBody.role, emailAddress: requestBody.emailAddress ?? null, domain: requestBody.domain ?? null };
            world.permissions.set(fileId, [...(world.permissions.get(fileId) ?? []), perm]);
            return { data: { id, role: perm.role, type: perm.type, emailAddress: perm.emailAddress } };
          },
        },
      },
      docs: {},
      accessToken: async () => "ya29.FAKE",
    }),
    baseGmailQuery: () => "",
  };
  // checkAutomationKey строится на реальном scopeCovers, с фиксированным
  // scope "drive:drive_trash" — ключевой новый тест: один и тот же ключ
  // должен пропускать ИМЕННО drive_trash и НЕ пропускать drive_share, хотя
  // оба гейтированы, оба того же сервиса "drive".
  const checkAutomationKeyMock = async (key, tool) => (key === "GOOD" && scopeCovers("drive:drive_trash", "drive", tool) ? { ok: true, channel: "window:test" } : { ok: false });
  // Фейковый in-memory ConsentStore (тот же приём, что и test-drive-gate.mjs
  // harness) — automation_key-путь всё равно строит план через `plan()` и
  // проходит binding-чек (rehash), которому нужно куда-то положить манифест,
  // даже когда мутация проходит с первого вызова.
  const manifests = new Map();
  const consentStore = {
    async createManifest(input) {
      manifests.set(input.id, { ...input, status: "AWAITING_CONSENT", consumedAt: null, userReply: null });
    },
    async getManifest(id, server) {
      const r = manifests.get(id);
      return r && r.server === server ? { ...r } : null;
    },
    async consumeManifest(id, server, userReply) {
      const r = manifests.get(id);
      if (!r || r.server !== server || r.status !== "AWAITING_CONSENT") return null;
      if (Date.now() >= r.expiresAt) return null;
      r.status = "DONE";
      r.userReply = userReply;
      return { ...r };
    },
    async invalidateManifest(id, server, userReply) {
      const r = manifests.get(id);
      if (r && r.server === server && r.status === "AWAITING_CONSENT") {
        r.status = "INVALIDATED";
        r.userReply = userReply;
      }
    },
    async appendConsentAudit() {},
    async updateConsentAuditOutcome() {},
  };
  const consentCtx = {
    consentStore,
    consentCfg: { server: "drive", consentTtlMs: 3_600_000, minConsentGapMs: 0, sendBatchMax: 10 },
    auditStore: null,
    checkAutomationKey: checkAutomationKeyMock,
  };
  const server = new McpServer2({ name: "drive-scope-e2e", version: "0" });
  registerAccountTools(server, clients);
  registerDriveTools(server, clients, consentCtx);
  const cli = new Client({ name: "c", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), cli.connect(a)]);

  const trashResp = await cli.callTool({ name: "drive_trash", arguments: { fileIds: ["F1"], automation_key: "GOOD" } });
  const trashBody = trashResp.content[0].text;
  check("drive_trash: scope на именно этот метод пропускает мутацию с первого вызова", world.files.get("F1").trashed === true, trashBody.slice(0, 200));

  const shareResp = await cli.callTool({ name: "drive_share", arguments: { fileId: "F1", type: "user", role: "reader", emailAddress: "x@example.com", automation_key: "GOOD" } });
  const shareBody = shareResp.content[0].text;
  check("drive_share: тот же ключ НЕ покрывает другой метод — обычный план, не мгновенная мутация", (world.permissions.get("F1") ?? []).length === 0, shareBody.slice(0, 200));
  check("drive_share: ответ выглядит как план (есть manifest), не как готовый результат", /manifest_id|план/i.test(shareBody), shareBody.slice(0, 200));

  await Promise.all([cli.close(), server.close()]);
}

// ── [5] Регресс: bare-service scope по-прежнему покрывает ЛЮБОЙ метод ───────
console.log("\n[5] Регресс: старое bare-service окно (scope='drive') продолжает работать на ЛЮБОЙ метод сервиса");
{
  check("bare 'drive' покрывает drive_trash", scopeCovers("drive", "drive", "drive_trash"));
  check("bare 'drive' покрывает drive_share", scopeCovers("drive", "drive", "drive_share"));
  check("bare 'drive' покрывает ещё не существующий пока метод drive_whatever_future", scopeCovers("drive", "drive", "drive_whatever_future"));
}

// ── [2] GET /automation-key-catalog — живой HTTP-вызов ───────────────────────
console.log("\n[2] GET /automation-key-catalog: живой HTTP, ожидаемые имена методов");
{
  const port = 34567 + Math.floor(Math.random() * 1000);
  const config = {
    transport: "http",
    port,
    requireAuth: false,
    users: [],
    onboarding: { enabled: false },
  };
  await startHttpServer(config);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/automation-key-catalog`);
    check("HTTP 200", res.status === 200, String(res.status));
    const body = await res.json();
    check("service === AUTOMATION_SERVICE ('drive')", body.service === "drive", JSON.stringify(body).slice(0, 200));
    const names = (body.tools ?? []).map((t) => t.name).sort();
    const expectedAtLeast = [
      "docs_append_text",
      "docs_create",
      "docs_insert_text",
      "docs_raw_batch_update",
      "docs_replace_text",
      "drive_create_folder",
      "drive_create_upload_session",
      "drive_get_download_url",
      "drive_move",
      "drive_overwrite_file",
      "drive_rename",
      "drive_share",
      "drive_trash",
      "drive_unshare",
      "drive_upload_file",
      "skill_version_update",
    ];
    check(
      "все 16 ожидаемых гейтированных методов (drive_*/docs_*/skill_version_update) присутствуют",
      expectedAtLeast.every((n) => names.includes(n)),
      names.join(","),
    );
    check("ровно 16 методов в каталоге (никакой ручной список не разъехался с кодом)", names.length === 16, names.join(","));
    check("каждый элемент несёт description-строку", (body.tools ?? []).every((t) => typeof t.description === "string"));
  } finally {
    // startHttpServer не возвращает handle на server — процесс завершится
    // сам по себе после теста; отдельного listen().close() здесь нет, так
    // как startHttpServer это не экспонирует (см. src/http.ts, конец
    // функции — app.listen(config.port, ...) без сохранённого handle).
  }
}

console.log(failures === 0 ? "\nAll automation-key-catalog checks passed.\n" : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
