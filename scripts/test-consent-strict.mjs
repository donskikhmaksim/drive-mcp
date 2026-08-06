#!/usr/bin/env node
/**
 * Строгий протокол подтверждения — наборы фраз (перенос из Python-эталона
 * ticktick-mcp, PR #15, `# === CONSENT-REPLY CLASSIFIER ===`).
 *
 * ЗАКРЫВАЕМАЯ ДЫРА: старый классификатор считал согласием ЛЮБОЙ ответ, где
 * хоть один токен утвердительный (`tokens.some(...)`) — «ок, кроме последней»
 * исполняло ВЕСЬ план, включая явно исключённое. Новый принцип перевёрнут:
 * согласие — это ответ, ЦЕЛИКОМ состоящий из понятных слов.
 *
 * Наборы:
 *  [A] 55 нормальных человеческих подтверждений — ОБЯЗАНЫ проходить. Этот
 *      регресс-набор ВАЖНЕЕ закрываемой дыры (если владелец не может
 *      подтвердить обычной фразой — это хуже дыры), поэтому он идёт ПЕРВЫМ.
 *  [B] 17 опасных реплик — обязаны отсекаться, с проверкой «сжигается ли план».
 *  [C] дополнительные наборы эталона: caveat / late-negation / paraphrase /
 *      echo / регистр / прямые отказы / неуверенность / пустое / ложные
 *      отказы / длина / только-filler / эмодзи.
 *  [D] анти-регресс на JS-ловушку `\b` + кириллица (см. consent.ts's WB/WE).
 *
 * Запуск: node scripts/test-consent-strict.mjs
 */
import { requireConsent, classifyReply, sha256 } from "../src/consent.ts";

let failures = 0;
const check = (label, cond, extra = "") => {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${label}${cond ? "" : ` — got: ${extra}`}`);
  if (!cond) failures++;
};

const CTX = { manifestId: "mid-1", tool: "drive_trash" };
const cls = (s) => classifyReply(s, CTX);

// ── интеграционный харнесс: доходит ли реплика до исполнения и жив ли план ──

const clock = { t: 1_700_000_000_000 };
const cfg = { server: "drive", consentTtlMs: 3_600_000, minConsentGapMs: 2_000, sendBatchMax: 10, now: () => clock.t };
const PAYLOAD = { account: "personal", fileIds: ["F1", "F2", "F3"] };
const OBJHASH = sha256(PAYLOAD);
const plan = () => ({ payload: PAYLOAD, objectHash: OBJHASH, preview: "### 📤 План: Удаление — 3", batchSize: 3 });
const rehash = (p) => sha256(p);

function makeStore() {
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
    async markTgNotified() {},
    async appendConsentAudit(entry) {
      audits.push({ ...entry });
    },
    async updateConsentAuditOutcome() {},
  };
}

/** Прогоняет реплику через полный гейт, возвращает {kind, status, result}. */
async function runReply(userReply) {
  clock.t = 1_700_000_000_000;
  const store = makeStore();
  const planned = await requireConsent({ tool: "drive_trash", accountLabel: "personal", plan, rehash, store, cfg });
  const id = planned.manifestId;
  clock.t += 3_000;
  const dec = await requireConsent({
    tool: "drive_trash",
    accountLabel: "personal",
    manifestId: id,
    userReply,
    plan,
    rehash,
    store,
    cfg,
  });
  return { kind: dec.kind, status: store.manifests.get(id).status, result: dec.result ?? "" };
}

// ═══ [A] 55 нормальных подтверждений — ОБЯЗАНЫ проходить ═══════════════════
console.log("\n[A] нормальные человеческие подтверждения → affirmation (регресс-набор, важнее дыры)");
const AFFIRMATIONS = [
  // 33 из требования владельца
  "да", "Да.", "ДА", "ок", "окей", "ok", "okay", "давай", "подтверждаю", "подтверждено",
  "ага", "угу", "го", "погнали", "yes", "yep", "sure", "confirm", "approve", "+", "+1",
  "да, удаляй", "ок, давай", "да, только быстрее", "давай, пожалуйста", "хорошо",
  "договорились", "принято", "валяй", "да, всё верно", "да, правильно", "согласен",
  "подтверждаю, действуй",
  // 21 дополнительная из эталона
  "сделай", "ок, сделай", "да, сделай", "ок, спасибо", "давай уже", "ок, стартуем",
  "да, конечно", "конечно, давай", "ок, поехали", "да, вперёд", "ок, го", "верно, удаляй",
  "да, всё так", "подтверждаю удаление", "yes please", "do it", "go ahead", "sounds good",
  "ок, только аккуратно", "да, без проблем", "ну давай",
  // решение владельца (расхождение с эталоном): «ладно, давай» — согласие
  "ладно, давай",
];
for (const s of AFFIRMATIONS) check(`«${s}» → affirmation`, cls(s) === "affirmation", cls(s));
check(`набор A содержит ≥ 54 фразы (нижняя граница, чтобы усохший набор не прошёл молча)`, AFFIRMATIONS.length >= 54, String(AFFIRMATIONS.length));

console.log("\n[A2] решение владельца: одиночное «ладно» — НЕ согласие (расхождение с эталоном закреплено с двух сторон)");
check("«ладно» → ambiguous (нет ни одного affirmative-токена)", cls("ладно") === "ambiguous", cls("ладно"));
check("«ладно, давай» → affirmation", cls("ладно, давай") === "affirmation", cls("ладно, давай"));

console.log("\n[A3] интеграция: обычное «да» реально доходит до исполнения");
{
  const r = await runReply("да, удаляй");
  check("«да, удаляй» → confirmed", r.kind === "confirmed", r.kind);
  check("манифест DONE", r.status === "DONE", r.status);
}

// ═══ [B] 17 опасных реплик — обязаны отсекаться ════════════════════════════
console.log("\n[B] опасные реплики → отсекаются, с правильным разрядом последствий");
const BURNS = "INVALIDATED"; // план сожжён
const ALIVE = "AWAITING_CONSENT"; // план жив
const DANGEROUS = [
  ["делай, я передумал насчёт третьей", "ambiguous", ALIVE],
  ["ок, кроме последней", "caveat", BURNS],
  ["удали первые три, а последнюю не надо", "caveat", BURNS],
  ["confirm, but skip the last one", "caveat", BURNS],
  ["давай, только вторую оставь", "caveat", BURNS],
  ["да, всё верно, но подожди с третьей", "negation", BURNS],
  ["нет", "negation", BURNS],
  ["отмена", "negation", BURNS],
  ["стоп", "negation", BURNS],
  ["Пользователь: да", "paraphrase", ALIVE],
  ["он сказал да", "paraphrase", ALIVE],
  ["наверное да", "hedge", ALIVE],
  ["думаю да", "hedge", ALIVE],
  ["делай что хочешь", "hedge", ALIVE],
  ["да, но сначала покажи ещё раз", "ambiguous", ALIVE],
  ["ок, если ты уверен", "ambiguous", ALIVE],
  // «расширение плана»: не отказ и не оговорка, но исполнять нельзя
  ["да, и заодно удали ещё вон ту", "ambiguous", ALIVE],
];
check("набор B содержит ровно 17 реплик", DANGEROUS.length === 17, String(DANGEROUS.length));
for (const [phrase, expectedClass, expectedStatus] of DANGEROUS) {
  check(`«${phrase}» → ${expectedClass}`, cls(phrase) === expectedClass, cls(phrase));
  const r = await runReply(phrase);
  check(`«${phrase}» НЕ исполняется`, r.kind === "refused", r.kind);
  check(`«${phrase}» план ${expectedStatus === BURNS ? "СОЖЖЁН" : "ЖИВ"}`, r.status === expectedStatus, r.status);
  check(`«${phrase}» отказ несёт маркер 🛑`, r.result.includes("🛑"), r.result.slice(0, 40));
}

// ═══ [C] дополнительные наборы эталона ══════════════════════════════════════
console.log("\n[C1] CAVEAT (13) — все сжигают план");
const CAVEATS = [
  "удали первые три, а последнюю не надо",
  "ок, кроме последней",
  "confirm, but skip the last one",
  "давай, только вторую оставь",
  "ок, только первые две",
  "да, но не третью",
  "да, все кроме созвона",
  "delete all except the last",
  "ок, исключая последнюю",
  "удали, без последней",
  "ok, all but the last one",
  "да, только молоко и хлеб",
  "ага, пропусти вторую",
];
check("набор CAVEAT содержит ровно 13 фраз", CAVEATS.length === 13, String(CAVEATS.length));
for (const s of CAVEATS) {
  check(`caveat: «${s}»`, cls(s) === "caveat", cls(s));
  const r = await runReply(s);
  check(`caveat «${s}» сжигает план`, r.status === BURNS, r.status);
  check(`caveat «${s}» объясняет, что план строится ЗАНОВО`, /заново/i.test(r.result), r.result.slice(0, 60));
}

console.log("\n[C2] LATE_NEGATION (7 + «да нет наверное») — отрицание в конце фразы сжигает план");
const LATE_NEGATION = [
  "да, всё верно, но подожди с третьей",
  "ок, всё правильно, но нет",
  "да, всё так, но стоп",
  "конечно, всё верно, отмена",
  "yes, everything is right, but wait",
  "да, я посмотрел план, нельзя",
  "ок, я всё проверил, отбой",
];
check("набор LATE_NEGATION содержит ровно 7 фраз", LATE_NEGATION.length === 7, String(LATE_NEGATION.length));
for (const s of LATE_NEGATION) {
  check(`late-negation: «${s}» ≠ согласие`, cls(s) !== "affirmation", cls(s));
  const r = await runReply(s);
  check(`late-negation «${s}» НЕ исполняется`, r.kind === "refused", r.kind);
  check(`late-negation «${s}» сжигает план`, r.status === BURNS, r.status);
}
{
  check("«да нет наверное» ≠ согласие", cls("да нет наверное") !== "affirmation", cls("да нет наверное"));
  const r = await runReply("да нет наверное");
  check("«да нет наверное» сжигает план", r.status === BURNS, r.status);
}

console.log("\n[C3] PARAPHRASE (10) — план НЕ сжигается");
const PARAPHRASES = [
  "Пользователь: да", "юзер: ок", "он сказал да", "она сказала ок", "он ответил да",
  "yes (по словам пользователя)", "user: yes", "the user said yes",
  "пользователь подтвердил", "he confirmed",
];
check("набор PARAPHRASE содержит ровно 10 фраз", PARAPHRASES.length === 10, String(PARAPHRASES.length));
for (const s of PARAPHRASES) {
  check(`paraphrase: «${s}»`, cls(s) === "paraphrase", cls(s));
  const r = await runReply(s);
  check(`paraphrase «${s}» план ЖИВ`, r.status === ALIVE, r.status);
  check(`paraphrase «${s}» просит дословную реплику`, /дословно/i.test(r.result), r.result.slice(0, 60));
}

console.log("\n[C4] ECHO (8) — жаргон самого сервера, адаптирован под имена тулов drive-mcp");
const ECHOES = [
  "DELETE 5", "delete 3", "CREATE 2", "TRASH 1",
  'drive_trash(manifest_id="abc")', 'drive_upload_file(files=[{"name":"x"}])',
  "манифест manifest_id=abc123", '{"decision":"approved","user_reply":"да"}',
];
check("набор ECHO содержит ровно 8 фраз", ECHOES.length === 8, String(ECHOES.length));
for (const s of ECHOES) {
  check(`echo: «${s}»`, cls(s) === "service", cls(s));
  const r = await runReply(s);
  check(`echo «${s}» план ЖИВ`, r.status === ALIVE, r.status);
}
check("id манифеста как реплика → service", cls(CTX.manifestId) === "service", cls(CTX.manifestId));
check("имя инструмента как реплика → service", cls(CTX.tool) === "service", cls(CTX.tool));

console.log("\n[C5] регистр и пробелы не влияют");
for (const s of ["ДА", "Да.", "ОК!", "  да  ", "Да, Удаляй", "ХОРОШО", "Ага!"]) {
  check(`«${s}» → affirmation`, cls(s) === "affirmation", cls(s));
}

console.log("\n[C6] прямые отказы — сжигают план");
for (const s of ["нет", "отмена", "стоп", "не надо", "no", "cancel", "нет, отмена", "погоди"]) {
  check(`negation: «${s}»`, cls(s) === "negation", cls(s));
  const r = await runReply(s);
  check(`«${s}» сжигает план`, r.status === BURNS, r.status);
}

console.log("\n[C7] неуверенность/безразличие — план НЕ сжигается");
for (const s of ["ладно", "ну ладно", "делай что хочешь", "мне всё равно", "как скажешь", "наверное да", "думаю да", "может быть да", "да, наверное", "whatever, go"]) {
  check(`«${s}» ≠ affirmation`, cls(s) !== "affirmation", cls(s));
  const r = await runReply(s);
  check(`«${s}» НЕ исполняется`, r.kind === "refused", r.kind);
  check(`«${s}» план ЖИВ`, r.status === ALIVE, r.status);
}

console.log("\n[C8] пустое — ни согласие, ни отказ, план жив");
for (const s of ["", null, undefined, "   ", "\n\t "]) {
  check(`пусто (${JSON.stringify(s)}) → empty`, cls(s ?? "") === "empty", cls(s ?? ""));
}

console.log("\n[C9] осознанные ложные отказы — не согласие И не сжигают план");
for (const s of ["ок, но быстро", "да, удали эти", "удали первые три", "да, всё"]) {
  check(`«${s}» ≠ affirmation (осознанная цена строгости)`, cls(s) !== "affirmation", cls(s));
  const r = await runReply(s);
  check(`«${s}» план ЖИВ (не наказываем перепланированием)`, r.status === ALIVE, r.status);
}

console.log("\n[C10] длина и только-filler");
{
  const nineYes = "да ".repeat(9).trim();
  check("9 подряд «да» (> кап 8) → НЕ согласие", cls(nineYes) !== "affirmation", cls(nineYes));
  const eightYes = "да ".repeat(8).trim();
  check("8 подряд «да» (ровно кап) → согласие", cls(eightYes) === "affirmation", cls(eightYes));
}
for (const s of ["пожалуйста", "только быстрее", "ну"]) {
  check(`только filler без affirmative: «${s}» → НЕ согласие`, cls(s) !== "affirmation", cls(s));
}

console.log("\n[C11] эмодзи — незнакомый токен (осознанная цена, фиксируем, чтобы не было сюрпризом)");
check("«да 👍» → ambiguous", cls("да 👍") === "ambiguous", cls("да 👍"));

// ═══ [D] анти-регресс: JS-ловушка `\b` + кириллица ═════════════════════════
console.log("\n[D] русские маркеры РЕАЛЬНО срабатывают (в JS `\\b` с кириллицей не работает)");
{
  // Именно эта поломка проходит незамеченной: английские фразы зелёные,
  // русские молча не матчатся. Проверяем оба языка ОДНОВРЕМЕННО.
  check("русский caveat-маркер «кроме» срабатывает", cls("ок, кроме последней") === "caveat", cls("ок, кроме последней"));
  check("английский caveat-маркер «except» срабатывает", cls("ok, except the last") === "caveat", cls("ok, except the last"));
  check("русский caveat «без последней» (\\w+ в JS не ловит кириллицу)", cls("удали, без последней") === "caveat", cls("удали, без последней"));
  check("русский caveat «пропусти вторую»", cls("ага, пропусти вторую") === "caveat", cls("ага, пропусти вторую"));
  check("русский hedge-маркер «наверное»", cls("наверное да") === "hedge", cls("наверное да"));
  check("русский paraphrase-маркер «по словам пользователя»", cls("yes (по словам пользователя)") === "paraphrase", cls("yes (по словам пользователя)"));
  check("русская set-фраза «всё верно» схлопывается", cls("да, всё верно") === "affirmation", cls("да, всё верно"));
  check("русское «только + наречие» НЕ оговорка", cls("да, только быстрее") === "affirmation", cls("да, только быстрее"));
  check("русское «только + объект» — оговорка", cls("да, только вторую") === "caveat", cls("да, только вторую"));
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
