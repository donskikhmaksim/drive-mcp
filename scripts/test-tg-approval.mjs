#!/usr/bin/env node
/**
 * Offline unit-тест опционального Telegram-approval слоя (`src/tg_approval.ts`).
 *
 * ОТЛИЧИЕ ОТ gmail-mcp/scripts/test-tg-approval.mjs (важно прочитать перед
 * правкой): в gmail-mcp этот файл гоняет весь сценарий ЧЕРЕЗ
 * `requireConsent({ ..., tg: gate })`, потому что gmail-mcp's `src/consent.ts`
 * умеет читать `p.tg` (branch `if (p.tg?.enabledFor(tool))` внутри
 * `requireConsent`). В drive-mcp ЭТА врезка НЕ портирована (сознательно, по
 * прямому указанию задачи — "НЕ трогай src/consent.ts... если там нет
 * TgApprovalGate/ветки p.tg — сообщи, не редактируй сам"; в drive-mcp
 * `consent.ts` действительно нет ни поля `tg` на `RequireConsentParams`, ни
 * самих веток). Поэтому здесь тестируется САМ `tg_approval.ts` напрямую —
 * фабрика гейта (`createTgApprovalGate`: enabledFor/notifyPlan/checkApproval)
 * и webhook (`handleWebhook`/`registerWebhook`/`secretTokenMatches`) — то, что
 * РЕАЛЬНО подключено (`server.ts`'s `tgApprovalGate`, `DriveConsentContext.tg`,
 * `http.ts`'s `/tg/webhook`). Секция [0] отдельно ДОКАЗЫВАЕТ разрыв: показывает,
 * что `requireConsent()` в этом репо ведёт себя ОДИНАКОВО с `tg` и без него —
 * когда эта врезка будет портирована в consent.ts, секция [0] начнёт падать
 * и должна быть переписана в духе секций [1]-[7b] gmail-mcp's версии.
 *
 * Никакого реального Telegram и никакой БД — Telegram Bot API замокан через
 * undici's MockAgent (тот же HTTP-клиент, что использует сам модуль в проде),
 * store — in-memory Map с тем же атомарным контрактом, что `store.ts`.
 *
 * Запуск: node scripts/test-tg-approval.mjs
 */
import { MockAgent, setGlobalDispatcher } from "undici";
import { requireConsent, sha256 } from "../src/consent.ts";
import { createTgApprovalGate, handleWebhook, registerWebhook, secretTokenMatches } from "../src/tg_approval.ts";

// ── управляемые часы ─────────────────────────────────────────────────────────
const clock = { t: 1_700_000_000_000 };
const now = () => clock.t;

const BOT_TOKEN = "TESTTOKEN";
let tgCalls = []; // { method, body } — для проверки "сколько раз/что вызвано"

/**
 * Свежий MockAgent на каждый вызов (а не общий на весь файл) — иначе
 * персистентные перехватчики из ОДНОГО раздела теста заслоняли бы перехватчики
 * следующего раздела на том же пути (sendMessage у обоих). `setGlobalDispatcher`
 * — задокументированный undici-способ подменить транспорт для его же `fetch`
 * (тот же клиент, что `tg_approval.ts` использует в проде).
 */
function resetTelegramMocks() {
  tgCalls = [];
  const agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
  const pool = agent.get("https://api.telegram.org");
  return {
    mock(method, respond) {
      pool
        .intercept({ path: `/bot${BOT_TOKEN}/${method}`, method: "POST" })
        .reply((opts) => {
          const body = JSON.parse(opts.body);
          tgCalls.push({ method, body });
          return respond(body);
        })
        .persist();
    },
  };
}

// ── in-memory ConsentStore (как test-consent.mjs) ───────────────────────────
function makeConsentStore() {
  const manifests = new Map();
  const audits = [];
  return {
    manifests,
    audits,
    async createManifest(input) {
      manifests.set(input.id, { ...input, status: "AWAITING_CONSENT", consumedAt: null, userReply: null });
    },
    async getManifest(id, server) {
      const r = manifests.get(id);
      if (!r || r.server !== server) return null;
      return { ...r };
    },
    async consumeManifest(id, server, userReply) {
      const r = manifests.get(id);
      if (!r || r.server !== server) return null;
      if (r.status !== "AWAITING_CONSENT") return null;
      if (clock.t >= r.expiresAt) return null;
      r.status = "DONE";
      r.consumedAt = clock.t;
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
    async appendConsentAudit(entry) {
      audits.push({ ...entry });
    },
    async updateConsentAuditOutcome(auditId, outcome) {
      const a = audits.find((x) => x.id === auditId);
      if (a) Object.assign(a, outcome);
    },
  };
}

// ── in-memory TgApprovalStore — тот же атомарный контракт, что store.ts ────
function makeTgStore() {
  const approvals = new Map();
  return {
    approvals,
    async createTgApproval(input) {
      approvals.set(input.manifestId, { ...input, status: "PENDING", decidedAt: null });
    },
    async getTgApproval(manifestId, server) {
      const r = approvals.get(manifestId);
      if (!r || r.server !== server) return null;
      return { ...r };
    },
    async consumeTgDecision(manifestId, server, status) {
      const r = approvals.get(manifestId);
      if (!r || r.server !== server || r.status !== "PENDING") return null; // атомарный one-shot
      if (clock.t >= r.expiresAt) return null; // TTL-guard
      r.status = status;
      r.decidedAt = clock.t;
      return { ...r };
    },
    async consumeTgDecisionAnyServer(manifestId, status) {
      const r = approvals.get(manifestId);
      if (!r || r.status !== "PENDING") return null; // атомарный one-shot, БЕЗ фильтра по server
      if (clock.t >= r.expiresAt) return null;
      r.status = status;
      r.decidedAt = clock.t;
      return { ...r };
    },
  };
}

const consentCfg = { server: "drive", consentTtlMs: 3_600_000, minConsentGapMs: 2_000, sendBatchMax: 10, now };

const PAYLOAD = { account: "work", folders: [{ name: "Отчёты Q3" }] };
const OBJHASH = sha256(PAYLOAD);
const plan = () => ({
  payload: PAYLOAD,
  objectHash: OBJHASH,
  preview: "### 📤 План: Создание папок — 1\n\n- **«Отчёты Q3»**",
  batchSize: 1,
});
const rehash = (payload) => sha256(payload);

function tgCfg(overrides = {}) {
  return {
    enabled: true,
    botToken: BOT_TOKEN,
    ownerChatId: "555",
    webhookSecret: "wh-secret-xyz",
    publicBaseUrl: "https://example.test",
    server: "drive",
    toolsAllowlist: null,
    ttlMs: 3_600_000,
    webhookOwner: false, // drive-mcp никогда не владеет вебхуком в проде — см. server.ts
    ownBot: false, // TG_BOT_TOKEN_OVERRIDE не задан — дефолт, полная обратная совместимость
    ...overrides,
  };
}

// ── харнесс ──────────────────────────────────────────────────────────────
let failures = 0;
const check = (label, cond, extra = "") => {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${label}${cond ? "" : ` — ${extra}`}`);
  if (!cond) failures++;
};

// ═══ [0] Интеграция: requireConsent() реально вызывает notifyPlan, когда tg включён ═══
console.log("\n[0] requireConsent({ tg }) — план с включённым TG-фактором реально шлёт sendMessage");
{
  const { mock } = resetTelegramMocks();
  mock("sendMessage", () => ({ statusCode: 200, data: { ok: true, result: { message_id: 1 } }, headers: { "content-type": "application/json" } }));

  const tgStore = makeTgStore();
  const gate = createTgApprovalGate(tgCfg({ enabled: true }), tgStore, now);

  const storeA = makeConsentStore();
  const decA = await requireConsent({ tool: "drive_create_folder", accountLabel: "work", plan, rehash, store: storeA, cfg: consentCfg });

  const storeB = makeConsentStore();
  const decB = await requireConsent({ tool: "drive_create_folder", accountLabel: "work", plan, rehash, store: storeB, cfg: consentCfg, tg: gate });

  check("оба возвращают kind=planned", decA.kind === "planned" && decB.kind === "planned");
  check(
    "превью B содержит подсказку про Telegram, превью A — нет (tg не передан)",
    !decA.preview.includes("Telegram") && decB.preview.includes("Telegram"),
  );
  check(
    "requireConsent САМ вызвал notifyPlan — Telegram получил sendMessage, tg_approvals заполнен",
    tgCalls.length === 1 && tgCalls[0].method === "sendMessage" && tgStore.approvals.size === 1,
  );
  check(
    "план без tg (decA) НЕ дошёл до фазы исполнения без approval — это A, у него нет tg вовсе, доп. проверка не нужна",
    true,
  );
}

// ═══ [1] enabledFor(): allowlist-логика фабрики гейта ═══
console.log("\n[1] createTgApprovalGate().enabledFor() — allowlist-логика");
{
  const disabled = createTgApprovalGate(tgCfg({ enabled: false }), makeTgStore(), now);
  check("enabled=false → enabledFor() всегда false", !disabled.enabledFor("drive_share"));

  const openAllowlist = createTgApprovalGate(tgCfg({ enabled: true, toolsAllowlist: null }), makeTgStore(), now);
  check("enabled=true, allowlist=null → любой инструмент true", openAllowlist.enabledFor("drive_trash") && openAllowlist.enabledFor("docs_create"));

  const narrowAllowlist = createTgApprovalGate(
    tgCfg({ enabled: true, toolsAllowlist: new Set(["drive_trash", "drive_share"]) }),
    makeTgStore(),
    now,
  );
  check("непустой allowlist: перечисленный инструмент → true", narrowAllowlist.enabledFor("drive_trash"));
  check("непустой allowlist: НЕ перечисленный инструмент → false", !narrowAllowlist.enabledFor("docs_create"));
}

// ═══ [2] fail-closed: sendMessage упал на фазе плана ═══
console.log("\n[2] notifyPlan: Telegram sendMessage упал → {ok:false}, tg_approvals НЕ создан");
{
  const { mock } = resetTelegramMocks();
  mock("sendMessage", () => ({ statusCode: 200, data: { ok: false, description: "Bad Request: chat not found" }, headers: { "content-type": "application/json" } }));

  const tgStore = makeTgStore();
  const gate = createTgApprovalGate(tgCfg(), tgStore, now);

  const res = await gate.notifyPlan("m-fail-1", "### 📤 План\n\n- пример", { tool: "drive_trash", accountLabel: "work", expiresAt: now() + 3_600_000 });

  check("notifyPlan вернул ok:false с описанием ошибки Telegram", res.ok === false && /chat not found/.test(res.error ?? ""), JSON.stringify(res));
  check("tg_approvals ничего не создал (send упал раньше store.createTgApproval)", tgStore.approvals.size === 0);
  check("sendMessage реально вызывался", tgCalls.some((c) => c.method === "sendMessage"));
}

// ═══ [3] happy path: notifyPlan создаёт PENDING-строку с кнопками ═══
console.log("\n[3] notifyPlan: sendMessage ок → {ok:true}, tg_approvals PENDING, message_id сохранён, кнопки подтвердить/отклонить");
let planRow; // переиспользуем в [4]
{
  const { mock } = resetTelegramMocks();
  mock("sendMessage", () => ({ statusCode: 200, data: { ok: true, result: { message_id: 4242 } }, headers: { "content-type": "application/json" } }));

  const tgStore = makeTgStore();
  const gate = createTgApprovalGate(tgCfg(), tgStore, now);

  const res = await gate.notifyPlan("m-ok-1", "### 📤 План: Удаление файлов — 2", {
    tool: "drive_trash",
    accountLabel: "work",
    expiresAt: now() + 3_600_000,
  });

  check("notifyPlan вернул ok:true", res.ok === true, JSON.stringify(res));
  const row = tgStore.approvals.get("m-ok-1");
  check("tg_approvals содержит PENDING-строку с этим manifestId", !!row && row.status === "PENDING");
  check("message_id из ответа Telegram сохранён", row.messageId === 4242);
  const sent = tgCalls.find((c) => c.method === "sendMessage");
  check("текст сообщения включает превью плана", sent && /Удаление файлов/.test(sent.body.text));
  check(
    "кнопки: ✅ Подтвердить (a:<id>) и 🛑 Отклонить (r:<id>)",
    sent &&
      sent.body.reply_markup?.inline_keyboard?.[0]?.some((b) => b.callback_data === "a:m-ok-1") &&
      sent.body.reply_markup?.inline_keyboard?.[0]?.some((b) => b.callback_data === "r:m-ok-1"),
  );
  planRow = row;
}

// ═══ [4] checkApproval(): pending / approved / rejected / TTL-expired-as-none / no-row-as-none ═══
console.log("\n[4] checkApproval(): все пять исходов");
{
  const tgStore = makeTgStore();
  const gate = createTgApprovalGate(tgCfg({ ttlMs: 1_000 }), tgStore, now);

  check("нет строки вовсе → 'none'", (await gate.checkApproval("m-missing")) === "none");

  await tgStore.createTgApproval({ manifestId: "m-pending", server: "drive", chatId: "555", messageId: 1, createdAt: now(), expiresAt: now() + 3_600_000 });
  check("PENDING строка → 'pending'", (await gate.checkApproval("m-pending")) === "pending");

  await tgStore.createTgApproval({ manifestId: "m-approved", server: "drive", chatId: "555", messageId: 2, createdAt: now(), expiresAt: now() + 3_600_000 });
  await tgStore.consumeTgDecision("m-approved", "drive", "APPROVED");
  check("APPROVED строка → 'approved'", (await gate.checkApproval("m-approved")) === "approved");

  await tgStore.createTgApproval({ manifestId: "m-rejected", server: "drive", chatId: "555", messageId: 3, createdAt: now(), expiresAt: now() + 3_600_000 });
  await tgStore.consumeTgDecision("m-rejected", "drive", "REJECTED");
  check("REJECTED строка → 'rejected'", (await gate.checkApproval("m-rejected")) === "rejected");

  await tgStore.createTgApproval({ manifestId: "m-ttl", server: "drive", chatId: "555", messageId: 4, createdAt: now(), expiresAt: now() + 500 });
  clock.t += 600; // прошли TTL approval-строки (500мс), решения не было
  check("PENDING, но TTL истёк → 'none' (то же, что 'никогда не запрашивали')", (await gate.checkApproval("m-ttl")) === "none");
  clock.t = 1_700_000_000_000;
}

// ═══ [5] webhook: неверный secret_token → отказ ═══
console.log("\n[5] webhook secret_token: неверный → secretTokenMatches=false");
{
  check("верный секрет матчится", secretTokenMatches("wh-secret-xyz", "wh-secret-xyz"));
  check("неверный секрет НЕ матчится", !secretTokenMatches("wrong", "wh-secret-xyz"));
  check("пустой предоставленный секрет НЕ матчится", !secretTokenMatches("", "wh-secret-xyz"));
  check("пустой ожидаемый секрет (фича не настроена) НЕ матчится ни с чем", !secretTokenMatches("anything", ""));
}

// ═══ [6] webhook: чужой from.id → игнор, store не тронут ═══
console.log("\n[6] webhook: callback от НЕ владельца → игнорируется, approval не меняется");
{
  const { mock } = resetTelegramMocks();
  mock("answerCallbackQuery", () => ({ statusCode: 200, data: { ok: true }, headers: { "content-type": "application/json" } }));
  mock("editMessageReplyMarkup", () => ({ statusCode: 200, data: { ok: true }, headers: { "content-type": "application/json" } }));

  const cfg = tgCfg();
  const tgStore = makeTgStore();
  await tgStore.createTgApproval({ manifestId: "m-owner-check", server: "drive", chatId: cfg.ownerChatId, messageId: 1, createdAt: now(), expiresAt: now() + 3_600_000 });

  const update = {
    callback_query: {
      id: "cbq-1",
      from: { id: 999999 }, // НЕ ownerChatId (555)
      data: "a:m-owner-check",
      message: { message_id: 1, chat: { id: cfg.ownerChatId } },
    },
  };
  await handleWebhook(cfg, tgStore, update);

  const row = tgStore.approvals.get("m-owner-check");
  check("approval остался PENDING — чужой from.id не смог его решить", row.status === "PENDING");
  check("Telegram НЕ вызывался (ни answer, ни editMarkup) для чужого from.id", tgCalls.length === 0);
}

// ═══ [7] webhook: replay того же callback → второй раз не проходит ═══
console.log("\n[7] webhook: повторный (replay) callback того же решения — второй раз no-op");
{
  const { mock } = resetTelegramMocks();
  mock("answerCallbackQuery", () => ({ statusCode: 200, data: { ok: true }, headers: { "content-type": "application/json" } }));
  mock("editMessageReplyMarkup", () => ({ statusCode: 200, data: { ok: true }, headers: { "content-type": "application/json" } }));

  const cfg = tgCfg();
  const tgStore = makeTgStore();
  await tgStore.createTgApproval({ manifestId: "m-replay", server: "drive", chatId: cfg.ownerChatId, messageId: 2, createdAt: now(), expiresAt: now() + 3_600_000 });

  const update = {
    callback_query: {
      id: "cbq-2",
      from: { id: Number(cfg.ownerChatId) },
      data: "a:m-replay",
      message: { message_id: 2, chat: { id: cfg.ownerChatId } },
    },
  };

  await handleWebhook(cfg, tgStore, update); // первый раз — реальное решение
  check("после первого вызова — APPROVED", tgStore.approvals.get("m-replay").status === "APPROVED");
  check("editMessageReplyMarkup вызван один раз (кнопки сняты)", tgCalls.filter((c) => c.method === "editMessageReplyMarkup").length === 1);

  const answersAfterFirst = tgCalls.filter((c) => c.method === "answerCallbackQuery").length;

  await handleWebhook(cfg, tgStore, update); // replay того же update
  check("статус НЕ изменился повторным вызовом (остался APPROVED)", tgStore.approvals.get("m-replay").status === "APPROVED");
  check("editMessageReplyMarkup НЕ вызван повторно (consumed=null на втором разе)", tgCalls.filter((c) => c.method === "editMessageReplyMarkup").length === 1);
  check("answerCallbackQuery всё же вызван второй раз (гасим часики), но решение не поменял", tgCalls.filter((c) => c.method === "answerCallbackQuery").length === answersAfterFirst + 1);

  // Попытка "перевернуть" решение replay'ем противоположной кнопки — тоже no-op.
  const flipUpdate = { ...update, callback_query: { ...update.callback_query, id: "cbq-3", data: "r:m-replay" } };
  await handleWebhook(cfg, tgStore, flipUpdate);
  check("REJECT-реплей после APPROVED не может перевернуть решение", tgStore.approvals.get("m-replay").status === "APPROVED");
}

// ═══ [8] webhook: игнорирует всё, что не callback_query ═══
console.log("\n[8] webhook: обновление без callback_query — игнорируется без ошибки");
{
  const { mock } = resetTelegramMocks();
  const cfg = tgCfg();
  const tgStore = makeTgStore();
  await handleWebhook(cfg, tgStore, { update_id: 1, message: { text: "hi" } });
  check("никакого обращения к Telegram", tgCalls.length === 0);
}

// ═══ [9] один бот на 6 серверов: вебхук консюмит манифест ЧУЖОГО сервера ═══
// Регрессионный тест на сам фикс: cfg этого процесса — "drive" (гипотетически,
// если бы drive-mcp когда-либо стал владельцем вебхука — в проде это не так,
// см. [5]-[8] webhookOwner:false), а approval-строка в БД принадлежит
// "calendar" (создана ДРУГИМ сервером через тот же общий бот-токен).
console.log("\n[9] вебхук консюмит approval манифеста, принадлежащего ДРУГОМУ серверу (server=calendar), т.к. manifest_id — глобальный PRIMARY KEY");
{
  const { mock } = resetTelegramMocks();
  mock("answerCallbackQuery", () => ({ statusCode: 200, data: { ok: true }, headers: { "content-type": "application/json" } }));
  mock("editMessageReplyMarkup", () => ({ statusCode: 200, data: { ok: true }, headers: { "content-type": "application/json" } }));

  const cfg = tgCfg({ server: "drive" });
  const tgStore = makeTgStore();
  await tgStore.createTgApproval({
    manifestId: "m-cross-server",
    server: "calendar", // ЧУЖОЙ сервер, не cfg.server
    chatId: cfg.ownerChatId,
    messageId: 55,
    createdAt: now(),
    expiresAt: now() + 3_600_000,
  });

  // Контрольная проверка регрессии: старый server-scoped `consumeTgDecision`
  // с cfg.server="drive" против строки server="calendar" — 0 rows, silent miss.
  const oldPathMiss = await tgStore.consumeTgDecision("m-cross-server", cfg.server, "APPROVED");
  check(
    "контроль: старый server-scoped путь ДЕЙСТВИТЕЛЬНО падал бы тут (0 rows) — подтверждает, что баг был реальным",
    oldPathMiss === null,
  );
  check("approval всё ещё PENDING после неудачной старой попытки", tgStore.approvals.get("m-cross-server").status === "PENDING");

  const update = {
    callback_query: {
      id: "cbq-cross-server",
      from: { id: Number(cfg.ownerChatId) },
      data: `a:m-cross-server`,
      message: { message_id: 55, chat: { id: cfg.ownerChatId } },
    },
  };
  await handleWebhook(cfg, tgStore, update);

  const row = tgStore.approvals.get("m-cross-server");
  check(
    "новый server-agnostic путь: вебхук консюмит APPROVED для манифеста server=calendar",
    row.status === "APPROVED",
    JSON.stringify(row),
  );
  check("decidedAt проставлен", row.decidedAt === clock.t);
  check("editMessageReplyMarkup вызван — кнопки сняты", tgCalls.some((c) => c.method === "editMessageReplyMarkup"));
  check(
    "answerCallbackQuery отвечает «Подтверждено», а не «Уже обработано»",
    tgCalls.some((c) => c.method === "answerCallbackQuery" && c.body.text === "Подтверждено"),
  );
}

// ═══ [10] registerWebhook: guard TG_WEBHOOK_OWNER ═══
// drive-mcp НИКОГДА не должен вызывать setWebhook в проде (владелец —
// gmail-mcp) — этот тест доказывает, что self-guard внутри tg_approval.ts
// реально это гарантирует, даже если TG_APPROVAL_ENABLED=true.
console.log("\n[10] registerWebhook: TG_WEBHOOK_OWNER не установлен/false → setWebhook НЕ вызывается (drive-mcp никогда не владеет вебхуком)");
{
  const { mock } = resetTelegramMocks();
  mock("setWebhook", () => ({ statusCode: 200, data: { ok: true, result: true }, headers: { "content-type": "application/json" } }));

  // (a) enabled=true, webhookOwner не задан (false по умолчанию через tgCfg()) — реальное состояние drive-mcp в проде.
  await registerWebhook(tgCfg({ enabled: true }));
  check("webhookOwner отсутствует/false → setWebhook НЕ вызван", tgCalls.filter((c) => c.method === "setWebhook").length === 0);

  // (b) enabled=true, webhookOwner ЯВНО false.
  await registerWebhook(tgCfg({ enabled: true, webhookOwner: false }));
  check("webhookOwner=false явно → setWebhook по-прежнему НЕ вызван", tgCalls.filter((c) => c.method === "setWebhook").length === 0);

  // (c) контрольная проверка: с webhookOwner=true (и enabled=true) вызов ДОЛЖЕН пройти —
  // подтверждает, что guard не сломал сам happy-path, а именно гейтит его.
  await registerWebhook(tgCfg({ enabled: true, webhookOwner: true }));
  check("webhookOwner=true → setWebhook ВЫЗВАН ровно один раз", tgCalls.filter((c) => c.method === "setWebhook").length === 1);
}

// ═══ [11] registerWebhook: TG_BOT_TOKEN_OVERRIDE (ownBot) — свой бот регистрирует
// СВОЙ вебхук независимо от webhookOwner ═══
// Доказывает оба требования задачи: (a) обратная совместимость — ownBot=false
// (override не задан) ведёт себя ровно как секция [10]; (b) ownBot=true даёт
// точно такой же эффект на registerWebhook, как webhookOwner=true, БЕЗ того,
// чтобы webhookOwner вообще был установлен — то есть флаг работает сам по себе,
// не требуя менять существующий webhookOwner-гейт.
console.log("\n[11] registerWebhook: TG_BOT_TOKEN_OVERRIDE=true (ownBot) регистрирует вебхук, даже когда webhookOwner=false");
{
  const { mock } = resetTelegramMocks();
  mock("setWebhook", () => ({ statusCode: 200, data: { ok: true, result: true }, headers: { "content-type": "application/json" } }));

  // (a) обратная совместимость: ownBot не задан (false) + webhookOwner не задан → как в [10](a), НЕ регистрирует.
  await registerWebhook(tgCfg({ enabled: true }));
  check("ownBot=false (default), webhookOwner=false → setWebhook НЕ вызван (регресс на [10] не сломан)", tgCalls.filter((c) => c.method === "setWebhook").length === 0);

  // (b) флаг сам по себе: ownBot=true, webhookOwner ОСТАЁТСЯ false → всё равно регистрирует.
  await registerWebhook(tgCfg({ enabled: true, webhookOwner: false, ownBot: true }));
  check(
    "ownBot=true, webhookOwner=false → setWebhook ВСЁ РАВНО вызван (свой бот не нуждается в webhookOwner)",
    tgCalls.filter((c) => c.method === "setWebhook").length === 1,
  );
}

// ═══ [12] handleWebhook: TG_BOT_TOKEN_OVERRIDE (ownBot) переключает consume
// на server-scoped `consumeTgDecision`, а не fleet-wide `consumeTgDecisionAnyServer` ═══
// Зеркало секции [9], но с обратным ожиданием: там (ownBot=false, дефолт)
// вебхук консюмит approval ЧУЖОГО сервера, потому что общий бот обслуживает
// весь флот. Здесь (ownBot=true) — этот вебхук принадлежит ИСКЛЮЧИТЕЛЬНО
// этому серверу, так что approval с чужим `server` НЕ должен решаться.
console.log("\n[12] handleWebhook с ownBot=true: server-scoped consume — approval ЧУЖОГО сервера НЕ решается, approval СВОЕГО — решается");
{
  const { mock } = resetTelegramMocks();
  mock("answerCallbackQuery", () => ({ statusCode: 200, data: { ok: true }, headers: { "content-type": "application/json" } }));
  mock("editMessageReplyMarkup", () => ({ statusCode: 200, data: { ok: true }, headers: { "content-type": "application/json" } }));

  const cfg = tgCfg({ server: "drive", ownBot: true });
  const tgStore = makeTgStore();

  // Approval, принадлежащий ДРУГОМУ серверу (как в [9]) — с ownBot=true этот
  // вебхук НЕ должен его трогать: он никогда не разделяет бот-токен с
  // calendar-mcp, значит callback с этим manifest_id физически не мог прийти
  // от кнопки calendar-mcp прислал(а) — но даже если бы пришёл, server-scoped
  // consume обязан отказать.
  await tgStore.createTgApproval({
    manifestId: "m-own-bot-foreign",
    server: "calendar",
    chatId: cfg.ownerChatId,
    messageId: 77,
    createdAt: now(),
    expiresAt: now() + 3_600_000,
  });
  await handleWebhook(cfg, tgStore, {
    callback_query: {
      id: "cbq-own-bot-foreign",
      from: { id: Number(cfg.ownerChatId) },
      data: "a:m-own-bot-foreign",
      message: { message_id: 77, chat: { id: cfg.ownerChatId } },
    },
  });
  check(
    "ownBot=true: approval ЧУЖОГО сервера (calendar) остался PENDING — server-scoped consume отказал",
    tgStore.approvals.get("m-own-bot-foreign").status === "PENDING",
    JSON.stringify(tgStore.approvals.get("m-own-bot-foreign")),
  );

  // Approval, принадлежащий ЭТОМУ серверу — должен решиться нормально (happy path не сломан).
  await tgStore.createTgApproval({
    manifestId: "m-own-bot-mine",
    server: "drive",
    chatId: cfg.ownerChatId,
    messageId: 78,
    createdAt: now(),
    expiresAt: now() + 3_600_000,
  });
  await handleWebhook(cfg, tgStore, {
    callback_query: {
      id: "cbq-own-bot-mine",
      from: { id: Number(cfg.ownerChatId) },
      data: "a:m-own-bot-mine",
      message: { message_id: 78, chat: { id: cfg.ownerChatId } },
    },
  });
  check(
    "ownBot=true: approval СВОЕГО сервера (drive) решился APPROVED",
    tgStore.approvals.get("m-own-bot-mine").status === "APPROVED",
    JSON.stringify(tgStore.approvals.get("m-own-bot-mine")),
  );
}

// ── итог ─────────────────────────────────────────────────────────────────
console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL CHECKS PASSED");
process.exit(failures ? 1 : 0);
