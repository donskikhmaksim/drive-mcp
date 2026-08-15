#!/usr/bin/env node
/**
 * Offline unit-тест ядра consent-гейта (`src/consent.ts`).
 *
 * Ported byte-for-byte from gmail-mcp/scripts/test-consent.mjs (consent.ts is
 * the same generic module, copied verbatim — mcp-development-standard
 * `references/development-pipeline.md` T2). Only the tool names in the test
 * scenarios (drive_share/drive_trash in place of gmail_send/gmail_forward)
 * and `cfg` (server="drive", minConsentGapMs=2000 — the gate.md §3.3(5)
 * generic default, NOT gmail's mail-specific 10000/5000 override) differ;
 * consent.ts's logic under test is tool-agnostic. Chistая логика: фейковый
 * in-memory ConsentStore, инъекция часов — ни БД, ни сети.
 *
 * Запуск (Node ≥ 22.18 грузит .ts напрямую, tsx/build не нужны):
 *   node scripts/test-consent.mjs
 *
 * Покрывает все 6 проверок gate.md §3.3 по отдельности + фазу плана.
 */
import {
  requireConsent,
  classifyReply,
  canonicalJson,
  sha256,
} from "../src/consent.ts";

// ── фейковое хранилище + управляемые часы ───────────────────────────────────

const clock = { t: 1_700_000_000_000 }; // фиксированный старт (epoch ms)
const now = () => clock.t;

function makeStore() {
  const manifests = new Map();
  const audits = [];
  return {
    manifests,
    audits,
    async createManifest(input) {
      manifests.set(input.id, {
        ...input,
        status: "AWAITING_CONSENT",
        consumedAt: null,
        userReply: null,
      });
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
      if (clock.t >= r.expiresAt) return null; // TTL — как `expires_at > NOW()` в БД
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

const cfg = {
  server: "drive",
  consentTtlMs: 3_600_000, // 1 ч
  minConsentGapMs: 2_000, // дефолт gate.md §3.3(5) — не почтовый override (Q3)
  sendBatchMax: 10,
  now,
};

// payload и билдеры плана
const PAYLOAD = { account: "personal", items: [{ fileId: "FILE1", role: "reader", type: "user", emailAddress: "eric@x.com" }] };
const OBJHASH = sha256(PAYLOAD);
const plan = () => ({
  payload: PAYLOAD,
  objectHash: OBJHASH,
  preview: "### 📤 План: Открытие доступа — 1\n\n- **«report.pdf»** — выдать reader для eric@x.com",
  batchSize: 1,
});
// СИМУЛЯЦИЯ «мир не изменился»: в тесте нет реального объекта для перечитывания,
// поэтому rehash отдаёт тот же хеш → binding проходит. В боевом drive.ts rehash
// ОБЯЗАН перечитать живое состояние по id и захешировать ЕГО (не аргумент) —
// см. контракт ConsentAddressing/rehash в consent.ts. Тест 9 моделирует
// ИЗМЕНЕНИЕ мира.
const rehash = (payload) => sha256(payload);

// ── харнесс проверок ────────────────────────────────────────────────────────

let failures = 0;
const check = (label, cond, extra = "") => {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${label}${cond ? "" : ` — ${extra}`}`);
  if (!cond) failures++;
};

// helper: построить план и вернуть {store, manifestId}
async function buildPlan(overrides = {}) {
  const store = makeStore();
  const dec = await requireConsent({
    tool: "drive_share",
    accountLabel: "personal",
    plan,
    rehash,
    store,
    cfg,
    ...overrides,
  });
  return { store, dec };
}

// ── 0. хелперы canonicalJson / sha256 ───────────────────────────────────────
console.log("\n[0] canonicalJson / sha256 детерминизм");
check(
  "порядок ключей не влияет на canonicalJson",
  canonicalJson({ b: 1, a: { d: 4, c: 3 } }) === canonicalJson({ a: { c: 3, d: 4 }, b: 1 }),
);
check("sha256 стабилен для эквивалентных объектов", sha256({ x: 1, y: 2 }) === sha256({ y: 2, x: 1 }));
check("sha256 различает разные payload", sha256({ x: 1 }) !== sha256({ x: 2 }));

// ── 1. фаза плана ───────────────────────────────────────────────────────────
console.log("\n[1] фаза плана: planned, манифест создан, ничего не consumed");
{
  const { store, dec } = await buildPlan();
  check("kind=planned", dec.kind === "planned", JSON.stringify(dec).slice(0, 80));
  check("манифест создан", store.manifests.size === 1);
  check("статус AWAITING_CONSENT", [...store.manifests.values()][0].status === "AWAITING_CONSENT");
  check("превью несёт id плана", dec.kind === "planned" && dec.preview.includes(dec.manifestId));
  check("превью просит показать дословно и ждать", dec.preview.includes("дождись его ответа"));
  check("превью помечает истечение в PT", dec.preview.includes("PT"));
  check("в фазе плана аудит-мутация не пишется", store.audits.length === 0);
}

// ── 2. только один из пары → refused «нужны оба» ────────────────────────────
console.log("\n[2] половина пары (только manifest_id или только user_reply) → 🛑");
{
  const store = makeStore();
  const d1 = await requireConsent({ tool: "drive_share", accountLabel: "personal", manifestId: "x", plan, rehash, store, cfg });
  check("только id → refused", d1.kind === "refused" && d1.result.includes("Нужны оба"), d1.result?.slice(0, 60));
  const d2 = await requireConsent({ tool: "drive_share", accountLabel: "personal", userReply: "да", plan, rehash, store, cfg });
  check("только reply → refused", d2.kind === "refused" && d2.result.includes("Нужны оба"));
  check("манифест НЕ создан", store.manifests.size === 0);
  check("🛑 в заголовке отказа", d1.result.includes("🛑"));
}

// ── 3. батч > капа → 🛑 без манифеста ───────────────────────────────────────
console.log("\n[3] батч больше SEND_BATCH_MAX → 🛑, манифест не создан");
{
  const store = makeStore();
  const bigPlan = () => ({ payload: PAYLOAD, objectHash: OBJHASH, preview: "p", batchSize: 11 });
  const dec = await requireConsent({ tool: "drive_share", accountLabel: "personal", plan: bigPlan, rehash, store, cfg });
  check("kind=refused", dec.kind === "refused");
  check("сообщение про разбивку", dec.result.includes("Разбей") || dec.result.includes("больше предела"), dec.result?.slice(0, 80));
  check("манифест НЕ создан", store.manifests.size === 0);
}

// ── 4. happy path: план → (пауза > gap) → «да» → confirmed ──────────────────
console.log("\n[4] полный путь: план → подтверждение «да» → confirmed, payload из манифеста");
{
  clock.t = 1_700_000_000_000;
  const { store, dec: planned } = await buildPlan();
  const id = planned.manifestId;
  clock.t += 3_000; // прошло 3 с — анти-дуплет (2с) пройден
  const dec = await requireConsent({ tool: "drive_share", accountLabel: "personal", manifestId: id, userReply: "да, шарь", plan, rehash, store, cfg });
  check("kind=confirmed", dec.kind === "confirmed", JSON.stringify(dec).slice(0, 80));
  check("payload взят ИЗ манифеста", dec.kind === "confirmed" && canonicalJson(dec.payload) === canonicalJson(PAYLOAD));
  check("возвращён auditId", dec.kind === "confirmed" && typeof dec.auditId === "string");
  check("манифест теперь DONE", store.manifests.get(id).status === "DONE");
  check("аудит-строка confirmed записана", store.audits.some((a) => a.outcome === "confirmed"));
  check("user_reply в аудите дословно", store.audits.at(-1).userReply === "да, шарь");
  check("аудит несёт результаты 6 проверок", store.audits.at(-1).checks.oneShot === "ok" && store.audits.at(-1).checks.binding === "ok");
}

// ── 5. анти-дуплет: план+execute в одном ходе → 🛑, манифест ЖИВ ─────────────
console.log("\n[5] план+execute в одном ходе (gap<2с) → 🛑, манифест остаётся живым");
{
  clock.t = 1_700_000_000_000;
  const { store, dec: planned } = await buildPlan();
  const id = planned.manifestId;
  // никакой паузы: то же значение часов
  const dec = await requireConsent({ tool: "drive_share", accountLabel: "personal", manifestId: id, userReply: "да", plan, rehash, store, cfg });
  check("kind=refused", dec.kind === "refused");
  check("сообщение про «слишком быстро»", dec.result.includes("Слишком быстро"), dec.result?.slice(0, 60));
  check("манифест НЕ consumed, всё ещё AWAITING", store.manifests.get(id).status === "AWAITING_CONSENT");
}

// ── 6. служебные строки → 🛑, манифест жив ──────────────────────────────────
console.log("\n[6] служебные user_reply (SEND 1 / JSON / uuid / id / имя инструмента) → 🛑");
for (const svc of ['SEND 1', '{"ok":true}', '550e8400-e29b-41d4-a716-446655440000', "MANIFEST_ID_SELF", "TOOL_SELF"]) {
  clock.t = 1_700_000_000_000;
  const { store, dec: planned } = await buildPlan();
  const id = planned.manifestId;
  clock.t += 3_000;
  const reply = svc === "MANIFEST_ID_SELF" ? id : svc === "TOOL_SELF" ? "drive_share" : svc;
  const dec = await requireConsent({ tool: "drive_share", accountLabel: "personal", manifestId: id, userReply: reply, plan, rehash, store, cfg });
  check(`«${svc}» → refused (не ответ человека)`, dec.kind === "refused" && dec.result.includes("не ответ человека"), dec.result?.slice(0, 50));
  check(`«${svc}» — манифест жив`, store.manifests.get(id).status === "AWAITING_CONSENT");
}

// ── 7. отрицание → инвалидация; «нет, не отправляй» НЕ читается как «да» ─────
console.log("\n[7] отрицание инвалидирует манифест; «нет, не шарь» ≠ утверждение");
{
  check("classifyReply(«нет, не шарь») = negation", classifyReply("нет, не шарь", { manifestId: "x", tool: "drive_share" }) === "negation");
  check("classifyReply(«да, шарь») = affirmation", classifyReply("да, шарь", { manifestId: "x", tool: "drive_share" }) === "affirmation");
  clock.t = 1_700_000_000_000;
  const { store, dec: planned } = await buildPlan();
  const id = planned.manifestId;
  clock.t += 3_000;
  const dec = await requireConsent({ tool: "drive_share", accountLabel: "personal", manifestId: id, userReply: "нет, не шарь", plan, rehash, store, cfg });
  check("kind=refused (отменено)", dec.kind === "refused" && dec.result.includes("Отменено"));
  check("манифест INVALIDATED", store.manifests.get(id).status === "INVALIDATED");
  check("аудит помечен invalidated", store.audits.at(-1).outcome === "invalidated");
  // повторное исполнение инвалидированного → отказ
  clock.t += 1_000;
  const dec2 = await requireConsent({ tool: "drive_share", accountLabel: "personal", manifestId: id, userReply: "да", plan, rehash, store, cfg });
  check("инвалидированный не исполняется", dec2.kind === "refused");
}

// ── 8. неопределённый ответ → 🛑, манифест жив ──────────────────────────────
console.log("\n[8] ни да ни нет → 🛑, манифест жив");
{
  clock.t = 1_700_000_000_000;
  const { store, dec: planned } = await buildPlan();
  const id = planned.manifestId;
  clock.t += 3_000;
  const dec = await requireConsent({ tool: "drive_share", accountLabel: "personal", manifestId: id, userReply: "наверное как-нибудь потом", plan, rehash, store, cfg });
  check("kind=refused (не понял)", dec.kind === "refused" && dec.result.includes("Не понял"), dec.result?.slice(0, 50));
  check("манифест жив", store.manifests.get(id).status === "AWAITING_CONSENT");
}

// ── 9. binding: состояние изменилось → 🛑, манифест не consumed ──────────────
console.log("\n[9] binding: rehash не совпал → 🛑, манифест не исполнен");
{
  clock.t = 1_700_000_000_000;
  const { store, dec: planned } = await buildPlan();
  const id = planned.manifestId;
  clock.t += 3_000;
  const changedRehash = () => sha256({ changed: true }); // «permissions изменились»
  const dec = await requireConsent({ tool: "drive_share", accountLabel: "personal", manifestId: id, userReply: "да", plan, rehash: changedRehash, store, cfg });
  check("kind=refused (состояние изменилось)", dec.kind === "refused" && dec.result.includes("изменилось"));
  check("манифест НЕ consumed", store.manifests.get(id).status === "AWAITING_CONSENT");
}

// ── 10. одноразовость: второй execute → 🛑 ──────────────────────────────────
console.log("\n[10] одноразовость: повтор manifest_id после успеха → 🛑");
{
  clock.t = 1_700_000_000_000;
  const { store, dec: planned } = await buildPlan();
  const id = planned.manifestId;
  clock.t += 3_000;
  const first = await requireConsent({ tool: "drive_share", accountLabel: "personal", manifestId: id, userReply: "да", plan, rehash, store, cfg });
  check("первый — confirmed", first.kind === "confirmed");
  clock.t += 1_000;
  const second = await requireConsent({ tool: "drive_share", accountLabel: "personal", manifestId: id, userReply: "да", plan, rehash, store, cfg });
  check("повтор — refused", second.kind === "refused");
}

// ── 11. TTL: исполнение после истечения → 🛑 ────────────────────────────────
console.log("\n[11] TTL: исполнение после expiresAt → 🛑");
{
  clock.t = 1_700_000_000_000;
  const { store, dec: planned } = await buildPlan();
  const id = planned.manifestId;
  clock.t += cfg.consentTtlMs + 1_000; // за пределом TTL
  const dec = await requireConsent({ tool: "drive_share", accountLabel: "personal", manifestId: id, userReply: "да", plan, rehash, store, cfg });
  check("kind=refused (истёк)", dec.kind === "refused");
  check("манифест не DONE", store.manifests.get(id).status === "AWAITING_CONSENT");
}

// ── 12. сверка tool/account манифеста ───────────────────────────────────────
console.log("\n[12] чужой tool/account к манифесту → 🛑");
{
  clock.t = 1_700_000_000_000;
  const { store, dec: planned } = await buildPlan();
  const id = planned.manifestId;
  clock.t += 3_000;
  const dWrongTool = await requireConsent({ tool: "drive_trash", accountLabel: "personal", manifestId: id, userReply: "да", plan, rehash, store, cfg });
  check("другой tool → refused", dWrongTool.kind === "refused" && dWrongTool.result.includes("не найден"));
  const dWrongAcct = await requireConsent({ tool: "drive_share", accountLabel: "work", manifestId: id, userReply: "да", plan, rehash, store, cfg });
  check("другой account → refused", dWrongAcct.kind === "refused");
  check("манифест не тронут", store.manifests.get(id).status === "AWAITING_CONSENT");
}

// ── 13. classifyReply — батарея ─────────────────────────────────────────────
console.log("\n[13] classifyReply — словари RU+EN");
{
  const ctx = { manifestId: "mid", tool: "drive_share" };
  const aff = ["да", "ок", "окей", "давай", "подтверждаю", "отправляй", "го", "+", "yes", "confirm", "send it", "go ahead"];
  const neg = ["нет", "стоп", "отмена", "погоди", "не надо", "no", "cancel", "stop", "don't", "do not"];
  const unk = ["наверное", "хм", "что там по срокам"];
  for (const s of aff) check(`aff: «${s}»`, classifyReply(s, ctx) === "affirmation", classifyReply(s, ctx));
  for (const s of neg) check(`neg: «${s}»`, classifyReply(s, ctx) === "negation", classifyReply(s, ctx));
  for (const s of unk) check(`unk: «${s}»`, classifyReply(s, ctx) === "unknown", classifyReply(s, ctx));
  check("пустая строка → unknown", classifyReply("   ", ctx) === "unknown");
}

// ── 14. регрессии приёмки: negation-конструкция vs ложная инвалидация ───────
console.log("\n[14] дыры приёмки №1/№2: «not sure» ≠ да; «шарь, не тяни» ≠ отрицание");
{
  const ctx = { manifestId: "mid", tool: "drive_share" };

  // №1 — дыра безопасности: «not X» больше НЕ читается как affirmation.
  for (const s of ["not sure", "not ok", "not really"]) {
    check(`«${s}» НЕ affirmation`, classifyReply(s, ctx) !== "affirmation", classifyReply(s, ctx));
  }
  // «not sure»/«not ok» — конструкция «частица+affirmation» → отрицание.
  check("«not sure» = negation", classifyReply("not sure", ctx) === "negation");
  check("«not ok» = negation", classifyReply("not ok", ctx) === "negation");
  // «not really» — частица без утвердительной головы → unknown (не да и не инвалидация).
  check("«not really» = unknown", classifyReply("not really", ctx) === "unknown");

  // «не <affirmation>» → отрицание.
  check("«не отправляй» = negation", classifyReply("не отправляй", ctx) === "negation");
  check("«не надо» = negation", classifyReply("не надо", ctx) === "negation");

  // №2 — ложная инвалидация: «не» перед НЕ-головой = согласие, а не отрицание.
  check("«отправляй, не тяни» = affirmation", classifyReply("отправляй, не тяни", ctx) === "affirmation");
  // «чего ждёшь, не томи» — согласие без явного aff-слова → хотя бы НЕ отрицание.
  check("«чего ждёшь, не томи» ≠ negation", classifyReply("чего ждёшь, не томи", ctx) !== "negation");
  // одиночная частица «не» сама по себе — НЕ отрицание.
  check("одиночное «не» = unknown", classifyReply("не", ctx) === "unknown");
}

// ── 15. интеграция: «not sure» не мутирует; «не тяни» не роняет манифест ─────
console.log("\n[15] интеграция: «not sure» → НЕ confirmed; «отправляй, не тяни» → confirmed, манифест жив до этого");
{
  // №1 боевой сценарий: раньше «not sure» → confirmed (мутация исполнялась). Теперь — refused.
  clock.t = 1_700_000_000_000;
  const { store, dec: planned } = await buildPlan();
  const id = planned.manifestId;
  clock.t += 3_000;
  const dec = await requireConsent({ tool: "drive_share", accountLabel: "personal", manifestId: id, userReply: "not sure", plan, rehash, store, cfg });
  check("«not sure» → НЕ confirmed", dec.kind !== "confirmed", dec.kind);
  check("«not sure» → refused", dec.kind === "refused");
  check("«not sure» манифест НЕ DONE", store.manifests.get(id).status !== "DONE");

  // №2 боевой сценарий: согласие с частицей «не» → confirmed, НЕ инвалидация.
  clock.t = 1_700_000_000_000;
  const p2 = await buildPlan();
  const id2 = p2.dec.manifestId;
  clock.t += 3_000;
  const dec2 = await requireConsent({ tool: "drive_share", accountLabel: "personal", manifestId: id2, userReply: "отправляй, не тяни", plan, rehash, store: p2.store, cfg });
  check("«отправляй, не тяни» → confirmed", dec2.kind === "confirmed", dec2.kind);
  check("«отправляй, не тяни» манифест DONE, не INVALIDATED", p2.store.manifests.get(id2).status === "DONE");

  // одиночное «не» в реплике не инвалидирует манифест (unknown → refuse, план жив).
  clock.t = 1_700_000_000_000;
  const p3 = await buildPlan();
  const id3 = p3.dec.manifestId;
  clock.t += 3_000;
  const dec3 = await requireConsent({ tool: "drive_share", accountLabel: "personal", manifestId: id3, userReply: "ну не знаю", plan, rehash, store: p3.store, cfg });
  check("«ну не знаю» → refused (не понял)", dec3.kind === "refused");
  check("«ну не знаю» манифест ЖИВ (AWAITING)", p3.store.manifests.get(id3).status === "AWAITING_CONSENT");
}

// ── 16. automation_key быстрый путь (ТЗ TZ_automation_key_consent_gate.md) ──
console.log("\n[16] automation_key: валидный ключ исполняет с первого вызова; невалидный — тихий fallthrough");
{
  // (a) checkAutomationKey НЕ передан вовсе — уже покрыто тестами [1]-[15]
  // выше (ни один из них не передаёт automationKey/checkAutomationKey) —
  // регресс: побайтовое поведение как раньше. Отдельной проверки не нужно.

  // (b) валидный ключ (мок DI) → confirmed С ПЕРВОГО вызова, без
  // manifest_id/user_reply, manifestId в решении пустой (плана в БД нет).
  clock.t = 1_700_000_000_000;
  {
    const store = makeStore();
    const okCheck = async (key) => (key === "GOOD" ? { ok: true, channel: "window:abc123" } : { ok: false });
    const dec = await requireConsent({
      tool: "drive_share",
      accountLabel: "personal",
      plan,
      rehash,
      store,
      cfg,
      automationKey: "GOOD",
      checkAutomationKey: okCheck,
    });
    check("kind=confirmed с первого вызова", dec.kind === "confirmed", JSON.stringify(dec).slice(0, 100));
    check("manifestId пуст — манифест в БД не создавался", dec.kind === "confirmed" && dec.manifestId === "");
    check("payload из плана", dec.kind === "confirmed" && canonicalJson(dec.payload) === canonicalJson(PAYLOAD));
    check("ни один манифест не вставлен в store", store.manifests.size === 0);
    check("аудит-запись есть, actor=automation", store.audits.length === 1 && store.audits[0].actor === "automation");
    check("аудит несёт метку канала", store.audits[0].checks.automationKey === "window:abc123");
    check("аудит outcome=confirmed", store.audits[0].outcome === "confirmed");
  }

  // (c) невалидный/просроченный ключ → НЕ ошибка, тихий fallthrough на
  // обычный путь (без manifest_id/user_reply рядом — уходит в фазу плана,
  // как будто automation_key вообще не было; ключ не подсказывается модели).
  {
    const store = makeStore();
    const badCheck = async () => ({ ok: false });
    const dec = await requireConsent({
      tool: "drive_share",
      accountLabel: "personal",
      plan,
      rehash,
      store,
      cfg,
      automationKey: "BAD",
      checkAutomationKey: badCheck,
    });
    check("невалидный ключ → kind=planned (обычный путь, НЕ ошибка)", dec.kind === "planned", JSON.stringify(dec).slice(0, 100));
    check("манифест создан обычным путём", store.manifests.size === 1);
    check("отказ не упоминает automation_key вообще", !JSON.stringify(dec).toLowerCase().includes("automation"));
  }

  // (d) rehash разошёлся на automation-пути → отказ, НЕ тихое исполнение.
  {
    const store = makeStore();
    const okCheck = async () => ({ ok: true, channel: "window:xyz" });
    const changedRehash = () => sha256({ changed: true });
    const dec = await requireConsent({
      tool: "drive_share",
      accountLabel: "personal",
      plan,
      rehash: changedRehash,
      store,
      cfg,
      automationKey: "GOOD",
      checkAutomationKey: okCheck,
    });
    check("binding-рассинхрон на automation-пути → refused", dec.kind === "refused", JSON.stringify(dec).slice(0, 100));
    check("сообщение про изменившееся состояние", dec.kind === "refused" && dec.result.includes("изменилось"));
    check("ничего не consumed — манифестов и не создавалось", store.manifests.size === 0);
  }

  // (e) превышение cfg.sendBatchMax на automation-пути → тот же отказ, что и
  // на обычном плановом пути.
  {
    const store = makeStore();
    const okCheck = async () => ({ ok: true, channel: "window:cap" });
    const bigPlan = () => ({ payload: PAYLOAD, objectHash: OBJHASH, preview: "p", batchSize: 11 });
    const dec = await requireConsent({
      tool: "drive_share",
      accountLabel: "personal",
      plan: bigPlan,
      rehash,
      store,
      cfg,
      automationKey: "GOOD",
      checkAutomationKey: okCheck,
    });
    check("батч > капа на automation-пути → refused", dec.kind === "refused");
    check(
      "то же сообщение про разбивку, что и на обычном пути",
      dec.result.includes("Разбей") || dec.result.includes("больше предела"),
      dec.result?.slice(0, 80),
    );
    check("манифест не создан", store.manifests.size === 0);
  }

  // (f) пустой automationKey ("") с подключённым checkAutomationKey — ветка
  // не входит вовсе (как будто ключа не было), обычная фаза плана.
  {
    const store = makeStore();
    const okCheck = async () => ({ ok: true, channel: "window:should-not-be-called" });
    const dec = await requireConsent({
      tool: "drive_share",
      accountLabel: "personal",
      plan,
      rehash,
      store,
      cfg,
      automationKey: "",
      checkAutomationKey: okCheck,
    });
    check("пустой ключ → kind=planned, обычная фаза плана", dec.kind === "planned");
  }
}

// ── 17. Часть 1 (ТЗ_consent_web_hub.md): гибридное короткое ожидание ────────
// Реальные (маленькие) таймеры — sleep() внутри requireConsent использует
// настоящий setTimeout, часы cfg.now здесь НЕ подкручиваем вручную кроме
// теста таймаута (17.4), где нужен реально текущий Date.now, иначе цикл
// никогда не увидит now() >= deadline и тест повиснет.
{
  console.log("\n[17] Часть 1: гибридное короткое ожидание (sync-wait)");

  // 17.1 syncWaitMs=0 (дефолт cfg выше не задаёт это поле) — побайтово как
  // раньше: обычный planned, без единой доп. итерации опроса.
  {
    const store = makeStore();
    let getManifestCalls = 0;
    const wrapped = { ...store, getManifest: (...a) => { getManifestCalls++; return store.getManifest(...a); } };
    const dec = await requireConsent({ tool: "drive_share", accountLabel: "personal", plan, rehash, store: wrapped, cfg });
    check("syncWaitMs не задан → kind=planned как раньше", dec.kind === "planned");
    check("ни одного опроса стора сверх обычного плана", getManifestCalls === 0);
  }

  // 17.2 Подтверждено «человеком» в середине окна (мок меняет статус на 2-й
  // опрос) — requireConsent возвращает готовый положительный результат
  // ОДНИМ вызовом, БЕЗ повторного исполнения (см. большой комментарий в
  // consent.ts про двойное исполнение — намеренно НЕ kind:"confirmed", а
  // отдельный kind:"already_executed" БЕЗ поля payload: повторить мутацию
  // тулу физически нечем. До 2026-08-14 тот же исход ехал под kind:"refused",
  // из-за чего модель получала машинный сигнал «отказ» на успех).
  {
    const store = makeStore();
    let polls = 0;
    const flippingStore = {
      ...store,
      getManifest: async (id, server) => {
        polls++;
        if (polls >= 2) {
          const row = store.manifests.get(id);
          if (row) { row.status = "DONE"; row.consumedAt = clock.t; row.userReply = "подтверждаю через веб"; }
        }
        return store.getManifest(id, server);
      },
    };
    const syncCfg = { ...cfg, syncWaitMs: 200, syncPollMs: 5 };
    const dec = await requireConsent({ tool: "drive_share", accountLabel: "personal", plan, rehash, store: flippingStore, cfg: syncCfg });
    check("подтверждено в окне → kind=already_executed (НЕ повторное исполнение)", dec.kind === "already_executed", JSON.stringify(dec).slice(0, 120));
    check("это НЕ отказ — модель не должна видеть машинный «refused» на успехе", dec.kind !== "refused");
    check("в исходе нет payload — повторить мутацию нечем", !("payload" in dec));
    // Security-review 2026-08-14 (проблема №1): этот мок НЕ пишет
    // аудит-строку исполнения (`flippingStore` просто дёргает статус в
    // "DONE" напрямую, минуя `appendConsentAudit`/`getAuditByManifest`) — то
    // есть у сервера НЕТ данных о том, что реально произошло. Раньше
    // заголовок всё равно рисовал «✅ Подтверждено и исполнено» ТОЛЬКО по
    // совпадению binding-хеша — ровно та дыра, которую починили: заголовок
    // ДОЛЖЕН честно сказать «не удалось перепроверить», а не наврать про
    // подтверждённый успех. Текст всё ещё «положительный» в смысле «не
    // отказ, не 🛑» — просто больше не выдаёт непроверенное за проверенное.
    check(
      "текст честный: не 🛑/отказ, но и не лживое ✅ без пруфа",
      dec.kind === "already_executed" &&
        !dec.report.includes("🛑") &&
        !dec.report.includes("✅ Подтверждено и исполнено") &&
        dec.report.includes("не удалось перепроверить"),
      dec.report.slice(0, 200),
    );
    check("опрос остановился рано (не проболтался все 200мс)", polls < 40);
    check("манифест реально DONE в сторе (мутация «произошла» — консюм не наш)", [...store.manifests.values()][0].status === "DONE");
  }

  // 17.3 Отклонено в окне ожидания — refused с тем же текстом, что и обычный
  // путь отказа («Отменено пользователем»), манифест НЕ трогаем повторно.
  {
    const store = makeStore();
    let polls = 0;
    const flippingStore = {
      ...store,
      getManifest: async (id, server) => {
        polls++;
        if (polls >= 2) {
          const row = store.manifests.get(id);
          if (row) { row.status = "INVALIDATED"; row.userReply = "нет, не надо"; }
        }
        return store.getManifest(id, server);
      },
    };
    const syncCfg = { ...cfg, syncWaitMs: 200, syncPollMs: 5 };
    const dec = await requireConsent({ tool: "drive_share", accountLabel: "personal", plan, rehash, store: flippingStore, cfg: syncCfg });
    check("отклонено в окне → kind=refused", dec.kind === "refused");
    check("тот же текст, что и обычный путь отказа", dec.kind === "refused" && dec.result.includes("Отменено пользователем"));
    check("реплика попала в текст", dec.kind === "refused" && dec.result.includes("нет, не надо"));
  }

  // 17.4 Никто не решил за окно — таймаут → ОБЫЧНОЕ превью (planned), ровно
  // то же, что и без фичи; после этого обычный execute manifest_id+user_reply
  // по-прежнему работает (регресс). Настоящие часы (не фиксированные) —
  // иначе цикл никогда не увидит now() >= deadline.
  {
    const store = makeStore();
    const syncCfg = { ...cfg, syncWaitMs: 30, syncPollMs: 5, now: () => Date.now() };
    const dec = await requireConsent({ tool: "drive_share", accountLabel: "personal", plan, rehash, store, cfg: syncCfg });
    check("никто не решил → kind=planned (обычное превью)", dec.kind === "planned", JSON.stringify(dec).slice(0, 100));
    check("манифест остался AWAITING_CONSENT", [...store.manifests.values()][0].status === "AWAITING_CONSENT");

    // Регресс: обычный второй вызов с manifest_id+user_reply всё ещё работает.
    // minConsentGapMs=0 здесь: реальные часы (Date.now) между двумя вызовами
    // теста прошли миллисекунды, не 2с — это тест регресса execute-пути, а
    // не анти-дуплета (тот уже покрыт отдельно в [3] с управляемыми часами).
    const dec2 = await requireConsent({
      tool: "drive_share", accountLabel: "personal", plan, rehash, store,
      cfg: { ...syncCfg, minConsentGapMs: 0 },
      manifestId: dec.manifestId, userReply: "да, отправляй",
    });
    check("после таймаута обычный execute-вызов подтверждает как раньше", dec2.kind === "confirmed", JSON.stringify(dec2).slice(0, 100));
  }

  // 17.5 Binding-чек срабатывает и на sync-пути: rehash разошёлся →
  // положительный, но с явным предупреждением о рассинхроне, НЕ тихое
  // подтверждение без оговорок.
  {
    const store = makeStore();
    let polls = 0;
    const flippingStore = {
      ...store,
      getManifest: async (id, server) => {
        polls++;
        if (polls >= 2) {
          const row = store.manifests.get(id);
          if (row) { row.status = "DONE"; row.consumedAt = clock.t; row.userReply = "ок"; }
        }
        return store.getManifest(id, server);
      },
    };
    const mismatchRehash = () => sha256({ changed: true });
    const syncCfg = { ...cfg, syncWaitMs: 200, syncPollMs: 5 };
    const dec = await requireConsent({ tool: "drive_share", accountLabel: "personal", plan, rehash: mismatchRehash, store: flippingStore, cfg: syncCfg });
    // Мутацию всё равно УЖЕ исполнил другой канал — это не отказ, а отчёт с
    // честной оговоркой, что мир с момента плана уехал. Повторного исполнения
    // при этом быть не может: в исходе нет payload.
    check("binding-рассинхрон на sync-пути → already_executed (не тихое повторное исполнение)", dec.kind === "already_executed", JSON.stringify(dec).slice(0, 120));
    check("в исходе нет payload", !("payload" in dec));
    check("предупреждение о рассинхроне присутствует", dec.kind === "already_executed" && dec.report.toLowerCase().includes("измен"));
    check("НЕ положительный «Подтверждено и исполнено» заголовок без оговорок", dec.kind === "already_executed" && !dec.report.includes("✅ Подтверждено и исполнено"));
  }

  // 17.6 automation_key + sync одновременно: валидный ключ исполняет СРАЗУ,
  // до опроса — ни одной итерации опроса не происходит (automation-ветка
  // проверяется РАНЬШЕ hasId/hasReply-развилки, sync-wait живёт внутри
  // ветки "нет ни id, ни reply", до которой в этом случае дело не доходит).
  {
    const store = makeStore();
    let getManifestCalls = 0;
    const wrapped = { ...store, getManifest: (...a) => { getManifestCalls++; return store.getManifest(...a); } };
    const okCheck = async () => ({ ok: true, channel: "window:sync-ak" });
    const syncCfg = { ...cfg, syncWaitMs: 5_000, syncPollMs: 5 };
    const dec = await requireConsent({
      tool: "drive_share", accountLabel: "personal", plan, rehash, store: wrapped, cfg: syncCfg,
      automationKey: "GOOD", checkAutomationKey: okCheck,
    });
    check("automation_key + sync → confirmed немедленно", dec.kind === "confirmed");
    check("ни одной итерации опроса (automation — раньше sync-wait)", getManifestCalls === 0);
    check("манифест вообще не создавался (automation исполняет без хранения)", store.manifests.size === 0);
  }
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
