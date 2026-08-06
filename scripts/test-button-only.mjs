#!/usr/bin/env node
/**
 * «Исполнение только кнопкой» — перенос защиты из Python-эталона ticktick-mcp
 * (PR #17, merge 467018e) на TS-архитектуру этого репо.
 *
 * СУТЬ: если Telegram-слой включён И план РЕАЛЬНО ушёл кнопкой, текстовое
 * подтверждение для этого плана закрывается СОВСЕМ — модель физически не может
 * исполнить операцию, только человек нажатием. Это устраняет дыру «модель
 * сочиняет согласие за человека», а не уменьшает её.
 *
 * ОТЛИЧИЕ ОТ ЭТАЛОНА (архитектурное, не смысловое): в Python манифесты живут в
 * RAM, здесь — в Postgres, поэтому «план ушёл кнопкой» — это КОЛОНКА
 * `consent_manifests.tg_notified` (миграция в store.ts's `ensureSchema`), а не
 * ключ словаря. Ставится ровно там, где `notifyPlan` вернул успех.
 *
 * Запуск: node scripts/test-button-only.mjs   (после `npm run build`)
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { requireConsent, tryAutoExecute, isTgButtonOnly, sha256, TG_AUTO_REPLY_MARKER } from "../dist/consent.js";
import { registeredAutoExecuteTools } from "../dist/autoExecute.js";
import { registerDriveTools } from "../dist/tools/drive.js";
import { registerDocsTools } from "../dist/tools/docs.js";
import { registerSkillVersionTools } from "../dist/tools/skill_version.js";
import { registerAccountTools } from "../dist/accounts.js";

let failures = 0;
const check = (label, cond, extra = "") => {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${label}${cond ? "" : ` — got: ${extra}`}`);
  if (!cond) failures++;
};

// ── фейковое хранилище + управляемые часы ───────────────────────────────────

const clock = { t: 1_700_000_000_000 };
const cfg = { server: "drive", consentTtlMs: 3_600_000, minConsentGapMs: 2_000, sendBatchMax: 10, now: () => clock.t };
const PAYLOAD = { account: "personal", fileIds: ["F1"] };
const OBJHASH = sha256(PAYLOAD);
const plan = () => ({ payload: PAYLOAD, objectHash: OBJHASH, preview: "### 📤 План: Удаление — 1", batchSize: 1 });
const rehash = (p) => sha256(p);

function makeStore() {
  const manifests = new Map();
  const audits = [];
  const calls = { markTgNotified: 0 };
  return {
    manifests,
    audits,
    calls,
    async createManifest(input) {
      manifests.set(input.id, { ...input, status: "AWAITING_CONSENT", consumedAt: null, userReply: null, tgNotified: false });
    },
    async getManifest(id, server) {
      const r = manifests.get(id);
      return r && r.server === server ? { ...r } : null;
    },
    async consumeManifest(id, server, userReply) {
      const r = manifests.get(id);
      if (!r || r.server !== server || r.status !== "AWAITING_CONSENT" || clock.t >= r.expiresAt) return null;
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
    async markTgNotified(id, server) {
      calls.markTgNotified++;
      const r = manifests.get(id);
      if (r && r.server === server && r.status === "AWAITING_CONSENT") r.tgNotified = true;
    },
    async appendConsentAudit(entry) {
      audits.push({ ...entry });
    },
    async updateConsentAuditOutcome() {},
  };
}

/**
 * Фейковый ТГ-гейт. `enabled` и `approval` меняются В ЛЮБОЙ МОМЕНТ — именно
 * так тестируется «решение по СОСТОЯНИЮ плана, а не по текущей настройке».
 */
function makeGate(opts = {}) {
  const state = {
    enabled: opts.enabled ?? true,
    approval: opts.approval ?? "pending",
    hasExecutor: opts.hasExecutor ?? true,
    sendOk: opts.sendOk ?? true,
    calls: { notifyPlan: 0, checkApproval: 0, hasAutoExecutor: 0 },
  };
  return {
    state,
    enabledFor: () => state.enabled,
    async notifyPlan() {
      state.calls.notifyPlan++;
      return state.sendOk ? { ok: true } : { ok: false, error: "chat not found" };
    },
    async checkApproval() {
      state.calls.checkApproval++;
      return state.approval;
    },
    hasAutoExecutor: () => {
      state.calls.hasAutoExecutor++;
      return state.hasExecutor;
    },
  };
}

async function buildPlan(store, gate, tool = "drive_trash") {
  clock.t = 1_700_000_000_000;
  return requireConsent({ tool, accountLabel: "personal", plan, rehash, store, cfg, tg: gate });
}

async function execAttempt(store, gate, id, userReply, tool = "drive_trash") {
  return requireConsent({ tool, accountLabel: "personal", manifestId: id, userReply, plan, rehash, store, cfg, tg: gate });
}

// ═══ [1] pending: текстовое «да» ничего не исполняет ════════════════════════
console.log("\n[1] план ушёл кнопкой, кнопка ещё не нажата → текстовое «да» НЕ исполняет, план жив");
{
  const store = makeStore();
  const gate = makeGate({ approval: "pending" });
  const planned = await buildPlan(store, gate);
  const id = planned.manifestId;
  check("метка «план ушёл кнопкой» поставлена ровно один раз", store.calls.markTgNotified === 1, String(store.calls.markTgNotified));
  check("манифест помечен tgNotified", store.manifests.get(id).tgNotified === true);
  check("превью просит НАЖАТЬ кнопку, а не ответить «да»", /ТОЛЬКО кнопкой/.test(planned.preview) && !/ответьте «да»/.test(planned.preview), planned.preview.slice(-220));

  clock.t += 3_000;
  const dec = await execAttempt(store, gate, id, "да");
  check("kind=refused", dec.kind === "refused", dec.kind);
  check("отказ говорит про кнопку/Telegram/отключено", /кнопк/i.test(dec.result) && /Telegram/i.test(dec.result) && /отключено/i.test(dec.result), dec.result.slice(0, 120));
  check("манифест ЖИВ", store.manifests.get(id).status === "AWAITING_CONSENT", store.manifests.get(id).status);
}

// ═══ [2] содержание реплики больше не влияет НИ НА ЧТО ═════════════════════
console.log("\n[2] перебор реплик даёт ОДИНАКОВЫЙ отказ — суть фикса");
{
  const results = [];
  for (const reply of ["да", "давай, подтверждаю", "ага, делай"]) {
    const store = makeStore();
    const gate = makeGate({ approval: "pending" });
    const planned = await buildPlan(store, gate);
    clock.t += 3_000;
    const dec = await execAttempt(store, gate, planned.manifestId, reply);
    results.push(dec.result);
    check(`«${reply}» → refused`, dec.kind === "refused", dec.kind);
    check(`«${reply}» манифест жив`, store.manifests.get(planned.manifestId).status === "AWAITING_CONSENT");
  }
  check("все три отказа ТЕКСТУАЛЬНО одинаковы", new Set(results).size === 1, `${new Set(results).size} различных`);
  // Пустая реплика: в этой (TS) реализации она отсекается ЕЩЁ РАНЬШЕ — на
  // проверке «нужны оба параметра», до классификации. Класс отказа другой, чем
  // в Python-эталоне, но свойство то же: содержание реплики не даёт исполнения.
  {
    const store = makeStore();
    const gate = makeGate({ approval: "pending" });
    const planned = await buildPlan(store, gate);
    clock.t += 3_000;
    const dec = await execAttempt(store, gate, planned.manifestId, "");
    check("пустая реплика → тоже НЕ исполняет (отсекается раньше, на half-pair)", dec.kind === "refused", dec.kind);
    check("пустая реплика: манифест жив", store.manifests.get(planned.manifestId).status === "AWAITING_CONSENT");
  }
}

// ═══ [3] approved: отказ текстовому пути, но манифест НЕ гасится ═══════════
console.log("\n[3] кнопка нажата, фоновый исполнитель ещё не добрался → отказ, но план НЕ погашен");
{
  const store = makeStore();
  const gate = makeGate({ approval: "pending" });
  const planned = await buildPlan(store, gate);
  const id = planned.manifestId;
  gate.state.approval = "approved"; // человек нажал кнопку
  clock.t += 3_000;
  const dec = await execAttempt(store, gate, id, "да");
  check("kind=refused", dec.kind === "refused", dec.kind);
  check("отказ объясняет, что сервер исполняет САМ", /сервер исполняет/i.test(dec.result), dec.result.slice(0, 120));
  check("КРИТИЧНО: манифест НЕ погашен (иначе фоновый исполнитель ничего не найдёт)", store.manifests.get(id).status === "AWAITING_CONSENT", store.manifests.get(id).status);

  // ── обратная сторона: фоновый исполнитель находит план и РЕАЛЬНО исполняет
  const auto = await tryAutoExecute({ manifestId: id, tool: "drive_trash", accountLabel: "personal" }, rehash, store, cfg);
  check("фоновый исполнитель нашёл план и исполнил", auto !== null && auto.manifestId === id, String(auto));
  check("манифест теперь DONE", store.manifests.get(id).status === "DONE", store.manifests.get(id).status);
  check("в аудите честная метка кнопки", store.manifests.get(id).userReply === TG_AUTO_REPLY_MARKER, store.manifests.get(id).userReply);

  // ── идемпотентность: повторный текстовый вызов даёт внятное «уже исполнено»
  clock.t += 1_000;
  const again = await execAttempt(store, gate, id, "да");
  check("повторный вызов → refused", again.kind === "refused", again.kind);
  check("ответ говорит «уже исполнено кнопкой»", /Уже исполнено кнопкой/i.test(again.result), again.result.slice(0, 120));
  const auto2 = await tryAutoExecute({ manifestId: id, tool: "drive_trash", accountLabel: "personal" }, rehash, store, cfg);
  check("повторное авто-исполнение невозможно (операция не дублируется)", auto2 === null, String(auto2));
}

// ═══ [4] rejected → план сожжён ════════════════════════════════════════════
console.log("\n[4] кнопка «Отклонить» → план сожжён");
{
  const store = makeStore();
  const gate = makeGate({ approval: "pending" });
  const planned = await buildPlan(store, gate);
  const id = planned.manifestId;
  gate.state.approval = "rejected";
  clock.t += 3_000;
  const dec = await execAttempt(store, gate, id, "да");
  check("kind=refused", dec.kind === "refused", dec.kind);
  check("манифест INVALIDATED", store.manifests.get(id).status === "INVALIDATED", store.manifests.get(id).status);
}

// ═══ [5] approval=none (истёк) → план заново ═══════════════════════════════
console.log("\n[5] approval-строки нет / истекла → «построй план заново»");
{
  const store = makeStore();
  const gate = makeGate({ approval: "pending" });
  const planned = await buildPlan(store, gate);
  gate.state.approval = "none";
  clock.t += 3_000;
  const dec = await execAttempt(store, gate, planned.manifestId, "да");
  check("kind=refused", dec.kind === "refused", dec.kind);
  check("просит построить план заново", /заново/i.test(dec.result), dec.result.slice(0, 120));
}

// ═══ [6] СВОЙСТВО 1: решение по СОСТОЯНИЮ плана, а не по текущей настройке ══
console.log("\n[6] свойство 1: слой выключили ПОСЛЕ отправки кнопки → текстовый путь ВСЁ РАВНО закрыт");
{
  const store = makeStore();
  const gate = makeGate({ approval: "pending" });
  const planned = await buildPlan(store, gate);
  const id = planned.manifestId;
  gate.state.approval = "approved";
  gate.state.enabled = false; // TG_APPROVAL_ENABLED выключили между планом и исполнением
  clock.t += 3_000;
  const dec = await execAttempt(store, gate, id, "да");
  check("текстовое «да» НЕ исполняет даже при выключённом слое", dec.kind === "refused", dec.kind);
  check("манифест НЕ погашен", store.manifests.get(id).status === "AWAITING_CONSENT", store.manifests.get(id).status);
  // Реализация, читающая текущий `enabledFor()` вместо поля манифеста, здесь
  // бы исполнила мутацию — именно этот тест их различает.

  // Тот же принцип для «нет tg вообще»: план ушёл кнопкой, gate недоступен →
  // fail-closed, а не «раз проверить нечем, значит можно».
  const store2 = makeStore();
  const gate2 = makeGate({ approval: "pending" });
  const planned2 = await buildPlan(store2, gate2);
  clock.t += 3_000;
  const dec2 = await requireConsent({ tool: "drive_trash", accountLabel: "personal", manifestId: planned2.manifestId, userReply: "да", plan, rehash, store: store2, cfg });
  check("gate вообще не передан → fail-closed отказ", dec2.kind === "refused", dec2.kind);
  check("манифест жив", store2.manifests.get(planned2.manifestId).status === "AWAITING_CONSENT");
}

// ═══ [7] СВОЙСТВО 3: при выключенном слое всё как раньше ═══════════════════
console.log("\n[7] свойство 3: Telegram-слой выключен → обычный текстовый путь работает как раньше");
{
  const store = makeStore();
  const gate = makeGate({ enabled: false });
  const planned = await buildPlan(store, gate);
  const id = planned.manifestId;
  check("notifyPlan не вызывался", gate.state.calls.notifyPlan === 0, String(gate.state.calls.notifyPlan));
  check("метка НЕ ставилась", store.calls.markTgNotified === 0, String(store.calls.markTgNotified));
  check("превью НЕ обещает кнопку", !/кнопк/i.test(planned.preview), planned.preview.slice(-160));
  clock.t += 3_000;
  const dec = await execAttempt(store, gate, id, "да");
  check("текстовое «да» ИСПОЛНЯЕТ", dec.kind === "confirmed", dec.kind);
  check("статус кнопки не запрашивался НИ РАЗУ", gate.state.calls.checkApproval === 0, String(gate.state.calls.checkApproval));

  const store2 = makeStore();
  const gate2 = makeGate({ enabled: false });
  const p2 = await buildPlan(store2, gate2);
  clock.t += 3_000;
  const dec2 = await execAttempt(store2, gate2, p2.manifestId, "нет, отмена");
  check("«нет, отмена» по-прежнему отказ", dec2.kind === "refused", dec2.kind);
  check("«нет, отмена» по-прежнему сжигает план", store2.manifests.get(p2.manifestId).status === "INVALIDATED", store2.manifests.get(p2.manifestId).status);
}

// ═══ [8] мягкая деградация: метка есть, авто-исполнителя нет ═══════════════
console.log("\n[8] мягкая деградация: план ушёл кнопкой, но авто-исполнителя нет → текстовый путь открыт, кнопка обязательна");
{
  const store = makeStore();
  const gate = makeGate({ approval: "pending", hasExecutor: false });
  const planned = await buildPlan(store, gate);
  const id = planned.manifestId;
  check("превью честно просит ПОВТОРИТЬ вызов инструмента", /повторите вызов инструмента/i.test(planned.preview), planned.preview.slice(-260));
  clock.t += 3_000;
  const pending = await execAttempt(store, gate, id, "да");
  check("пока кнопка не нажата — отказ", pending.kind === "refused", pending.kind);
  gate.state.approval = "approved";
  const dec = await execAttempt(store, gate, id, "да");
  check("после нажатия текстовый путь исполняет (не «исполнить невозможно»)", dec.kind === "confirmed", dec.kind);
}

// ═══ [9] юнит формулы isTgButtonOnly ══════════════════════════════════════
console.log("\n[9] юнит: формула button-only — две строки, никаких списков имён тулов");
{
  const withExec = makeGate({ hasExecutor: true });
  const noExec = makeGate({ hasExecutor: false });
  check("нет метки → false", isTgButtonOnly({ tool: "drive_trash", tgNotified: false }, withExec) === false);
  check("метки нет вовсе (поле отсутствует) → false", isTgButtonOnly({ tool: "drive_trash" }, withExec) === false);
  check("метка есть, исполнителя нет → false", isTgButtonOnly({ tool: "drive_trash", tgNotified: true }, noExec) === false);
  check("метка + исполнитель → true", isTgButtonOnly({ tool: "drive_trash", tgNotified: true }, withExec) === true);
  check("метка есть, gate не передан → false (решает вызывающий, fail-closed)", isTgButtonOnly({ tool: "drive_trash", tgNotified: true }, undefined) === false);
  // Формула НЕ читает текущую настройку: выключенный слой ничего не меняет.
  const disabledButExec = makeGate({ enabled: false, hasExecutor: true });
  check("выключённый слой НЕ снимает button-only", isTgButtonOnly({ tool: "drive_trash", tgNotified: true }, disabledButExec) === true);
}

// ═══ [10] fail-closed на отправке и на пометке ════════════════════════════
console.log("\n[10] fail-closed: sendMessage упал → план убит, метка не поставлена");
{
  const store = makeStore();
  const gate = makeGate({ sendOk: false });
  const dec = await buildPlan(store, gate);
  check("kind=refused", dec.kind === "refused", dec.kind);
  check("метка НЕ ставилась", store.calls.markTgNotified === 0, String(store.calls.markTgNotified));
  const row = [...store.manifests.values()][0];
  check("манифест инвалидирован (не остался живым)", row.status === "INVALIDATED", row.status);
}
{
  // Пометка упала — план тоже не должен остаться исполняемым голым текстом.
  const store = makeStore();
  store.markTgNotified = async () => {
    throw new Error("db down");
  };
  const gate = makeGate({});
  const dec = await buildPlan(store, gate);
  check("markTgNotified упал → refused", dec.kind === "refused", dec.kind);
  const row = [...store.manifests.values()][0];
  check("markTgNotified упал → манифест инвалидирован", row.status === "INVALIDATED", row.status);
}

// ═══ [10b] Кодировка: русский текст отказа доходит ЦЕЛЫМ ══════════════════
console.log("\n[10b] тексты отказов русские — проверяем целостность UTF-8, а не «????»");
{
  const store = makeStore();
  const gate = makeGate({ approval: "pending" });
  const planned = await buildPlan(store, gate);
  clock.t += 3_000;
  const dec = await execAttempt(store, gate, planned.manifestId, "да");
  const russian = "Этот план подтверждается только кнопкой";
  check("русская подстрока присутствует ЦЕЛИКОМ (сравнение строк, не байтов)", dec.result.includes(russian), dec.result.slice(0, 120));
  check("в тексте нет следов битой кодировки (? ? ? / Ð / Ñ)", !/\?{3,}/.test(dec.result) && !/[ÐÑ]/.test(dec.result), dec.result.slice(0, 120));
  check("эмодзи-маркер 🛑 доходит целым (суррогатная пара не порвана)", dec.result.includes("🛑"), dec.result.slice(0, 40));
  check("длина в кодовых точках совпадает с ожидаемой подстрокой", [...russian].length === russian.length, String([...russian].length));
}

// ═══ [11] ИНВЕНТАРИЗАЦИЯ: у каждого гейтованного тула есть чем исполнить ═══
console.log("\n[11] инвентаризация: каждый гейтованный write-тул имеет авто-исполнитель (список — сканом реального реестра)");

/** Возвращает список нарушителей: гейтованные write-тулы без авто-исполнителя.
 * Вынесено в функцию, чтобы ниже проверить саму инвентаризацию мутацией. */
function inventoryViolations(gatedWrites, executors, allowlist) {
  return gatedWrites.filter((t) => !executors.has(t) && !(t in allowlist));
}

/** Поимённые исключения — только с объяснением. */
const NO_EXECUTOR_ALLOWLIST = {
  // (пусто) — на момент этой правки авто-исполнитель есть у ВСЕХ гейтованных
  // write-тулов репозитория. Новый тул без исполнителя обязан быть внесён сюда
  // с причиной, иначе этот тест падает.
};

{
  const stubClients = { names: ["personal"], defaultName: "personal", multi: false, resolve: () => ({}), baseGmailQuery: () => "" };
  const consentCtx = { consentStore: null, consentCfg: cfg, auditStore: null };
  const server = new McpServer({ name: "button-only-inventory", version: "0" });
  registerAccountTools(server, stubClients);
  registerDriveTools(server, stubClients, consentCtx);
  registerDocsTools(server, stubClients, consentCtx);
  registerSkillVersionTools(server, stubClients, consentCtx);
  const cli = new Client({ name: "c", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), cli.connect(a)]);
  const tools = (await cli.listTools()).tools;

  // Гейтованные write-тулы = всё, что не помечено readOnlyHint (та же рулетка,
  // что в test-gate-coverage.mjs) — берётся из ЖИВОГО реестра, не из хардкода.
  const gatedWrites = tools.filter((t) => t.annotations?.readOnlyHint !== true).map((t) => t.name);
  const executors = new Set(registeredAutoExecuteTools());

  // Нижняя граница: сломанный скан не должен молча пройти по пустому множеству.
  check(`гейтованных write-тулов найдено ≥ 15 (найдено ${gatedWrites.length})`, gatedWrites.length >= 15, String(gatedWrites.length));
  check(`авто-исполнителей зарегистрировано ≥ 15 (найдено ${executors.size})`, executors.size >= 15, String(executors.size));

  // ПРИЗНАК ЗАЩИЩЁННОСТИ — по ОПУБЛИКОВАННОЙ схеме инструмента, а не по
  // регулярке в исходнике: инструмент защищён тогда и только тогда, когда
  // модель ВИДИТ оба параметра подтверждения. Проверка по количеству методов
  // такое не ловит вовсе — имена совпадают, меняется только защищённость.
  for (const t of tools.filter((x) => x.annotations?.readOnlyHint !== true)) {
    const props = t.inputSchema?.properties ?? {};
    check(`${t.name}: опубликованная схема несёт manifest_id И user_reply`, "manifest_id" in props && "user_reply" in props, JSON.stringify(Object.keys(props)));
  }

  const violations = inventoryViolations(gatedWrites, executors, NO_EXECUTOR_ALLOWLIST);
  check("у каждого гейтованного write-тула есть авто-исполнитель", violations.length === 0, violations.join(", "));

  // ── мутационный тест НА САМУ ИНВЕНТАРИЗАЦИЮ: выбрасываем один тул из
  //    реестра исполнителей — инвентаризация обязана покраснеть.
  const mutated = new Set(executors);
  const victim = gatedWrites.find((t) => mutated.has(t));
  mutated.delete(victim);
  const mutatedViolations = inventoryViolations(gatedWrites, mutated, NO_EXECUTOR_ALLOWLIST);
  check(`мутация: без исполнителя «${victim}» инвентаризация краснеет`, mutatedViolations.length === 1 && mutatedViolations[0] === victim, mutatedViolations.join(", "));
  // И allowlist действительно работает как поимённое исключение.
  const excused = inventoryViolations(gatedWrites, mutated, { [victim]: "reason" });
  check("поимённое исключение в allowlist снимает нарушение", excused.length === 0, excused.join(", "));
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
