#!/usr/bin/env node
/**
 * Исход `already_executed` (2026-08-14) — подтверждение пришло ВНЕ этого
 * вызова (веб-хаб `/pending-consents/decide` или кнопка в Telegram) во время
 * синхронного ожидания.
 *
 * ЧТО ИМЕННО ЛЕЧИТСЯ. Максим: «подтверждаю в портале за 2 секунды, запрос
 * оттуда исчезает, а Claude не понимает, что всё сделано, и шлёт запрос
 * заново — и так несколько кругов». Причина: этот положительный исход ехал в
 * форме `{kind:"refused"}` с позитивным текстом внутри — то есть модели
 * доставался машинный сигнал «отказ» при тексте «✅ Подтверждено и исполнено».
 * Модель верит сигналу, а не прозе.
 *
 * ЧТО НЕЛЬЗЯ СЛОМАТЬ, чиня это: мутацию к этому моменту УЖЕ исполнил другой
 * канал (веб-хаб делает `tryAutoExecute` + исполнитель тула синхронно внутри
 * своего HTTP-запроса). Вернуть отсюда `confirmed` = второй файл, второе
 * расшаривание. Поэтому у нового исхода нет поля `payload` вообще — тесты 1 и
 * 5 проверяют именно это, а не только «kind поменялся».
 *
 * Тест 6 — статический: текст отчёта бесполезен, если хоть один тул отдаёт
 * его обычным `ok()` вместо `okExecutionReport` (без машинной метки исхода).
 *
 * Запуск: node scripts/test-already-executed.mjs
 */
import { readFileSync, readdirSync } from "node:fs";
import { requireConsent, sha256 } from "../src/consent.ts";

let failures = 0;
const check = (label, cond, extra = "") => {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${label}${cond ? "" : ` — ${extra}`}`);
  if (!cond) failures++;
};

const clock = { t: 1_700_000_000_000 };
const now = () => clock.t;

/** Фейковый стор: тот же контракт, что у `consentStoreAdapter` в server.ts,
 * включая ОПЦИОНАЛЬНЫЙ `getAuditByManifest` (его подключение — часть фикса:
 * без него ветка честно скажет «перепроверить не удалось», тест 3). */
function makeStore({ withAudit = true } = {}) {
  const manifests = new Map();
  const audits = [];
  const calls = { consume: 0, audit: 0 };
  const store = {
    manifests,
    audits,
    calls,
    async createManifest(input) {
      manifests.set(input.id, { ...input, status: "AWAITING_CONSENT", consumedAt: null, userReply: null });
    },
    async getManifest(id, server) {
      const r = manifests.get(id);
      if (!r || r.server !== server) return null;
      return { ...r };
    },
    async consumeManifest(id, server, userReply) {
      calls.consume++;
      const r = manifests.get(id);
      if (!r || r.server !== server || r.status !== "AWAITING_CONSENT") return null;
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
      if (a) Object.assign(a, { postVerifyResult: outcome.postVerify ?? a.postVerifyResult, ...outcome });
    },
  };
  if (withAudit) {
    // Тот же порядок, что у SQL-реализации в store.ts: сначала строка с уже
    // записанным пруфом, потом просто самая свежая.
    store.getAuditByManifest = async (manifestId, server) => {
      calls.audit++;
      const rows = audits.filter((a) => a.manifestId === manifestId && a.server === server);
      if (!rows.length) return null;
      const withProof = rows.filter((a) => a.postVerifyResult || a.error);
      const row = (withProof.length ? withProof : rows).at(-1);
      return {
        id: row.id,
        outcome: row.outcome,
        postVerifyResult: row.postVerifyResult ?? null,
        error: row.error ?? null,
      };
    };
  }
  return store;
}

const cfg = { server: "drive", consentTtlMs: 3_600_000, minConsentGapMs: 2_000, sendBatchMax: 10, now };
const syncCfg = { ...cfg, syncWaitMs: 200, syncPollMs: 5 };

const PAYLOAD = { account: "personal", items: [{ fileId: "FILE1", role: "reader", type: "user", emailAddress: "eric@x.com" }] };
const OBJHASH = sha256(PAYLOAD);
const plan = () => ({
  payload: PAYLOAD,
  objectHash: OBJHASH,
  preview: "### 📤 План: Открытие доступа — 1\n\n- **«report.pdf»** — выдать reader для eric@x.com",
  batchSize: 1,
});
const rehash = (payload) => sha256(payload);

/**
 * Симуляция ВНЕШНЕГО канала (веб-хаб): на 2-м опросе он атомарно потребляет
 * манифест, пишет аудит-строку фазы согласия и — как настоящий исполнитель
 * тула — дописывает в неё реальный пруф post-verify.
 */
function withExternalConfirm(store, { postVerify, error } = {}) {
  let polls = 0;
  return {
    ...store,
    getManifest: async (id, server) => {
      polls++;
      if (polls === 2) {
        await store.consumeManifest(id, server, "[веб-хаб: подтверждено]");
        const auditId = `audit-${id}`;
        await store.appendConsentAudit({
          id: auditId,
          ts: clock.t,
          server,
          tool: "drive_share",
          accountLabel: "personal",
          manifestId: id,
          objectHash: OBJHASH,
          userReply: "[веб-хаб: подтверждено]",
          checks: { source: "web_hub" },
          outcome: "confirmed",
          actor: "human",
        });
        if (postVerify !== undefined || error !== undefined) {
          await store.updateConsentAuditOutcome(auditId, {
            outcome: error ? "failed" : "confirmed",
            postVerify: postVerify ?? null,
            error: error ?? null,
          });
        }
      }
      return store.getManifest(id, server);
    },
  };
}

console.log("\n[1] подтверждено веб-хабом в окне ожидания → отчёт об исполнении, а НЕ отказ");
{
  const store = makeStore();
  const wrapped = withExternalConfirm(store, {
    postVerify: "✅ Доступ открыт 1/1 · post-verify: «report.pdf» — reader для eric@x.com",
  });
  const dec = await requireConsent({ tool: "drive_share", accountLabel: "personal", plan, rehash, store: wrapped, cfg: syncCfg });

  check("kind=already_executed", dec.kind === "already_executed", JSON.stringify(dec).slice(0, 140));
  check("НЕ refused (модель больше не видит машинный «отказ» на успехе)", dec.kind !== "refused");
  check("НЕ confirmed (иначе тул исполнил бы мутацию второй раз)", dec.kind !== "confirmed");
  check("в исходе нет payload — повторить мутацию физически нечем", !("payload" in dec));
  check("manifestId проброшен", dec.manifestId === [...store.manifests.keys()][0]);
  check("auditId проброшен", dec.auditId === `audit-${dec.manifestId}`, dec.auditId);
  check(
    "в отчёте есть ФАКТИЧЕСКИЙ результат (пруф post-verify), а не только «исполнено другим каналом»",
    dec.report.includes("Доступ открыт 1/1") && dec.report.includes("eric@x.com"),
    dec.report.slice(0, 220),
  );
  check("отчёт прямо говорит не повторять вызов", /НЕ нужно/.test(dec.report), dec.report.slice(-220));
  check(
    "requireConsent НЕ потреблял манифест сам (единственный consume — внешнего канала)",
    store.calls.consume === 1,
    store.calls.consume,
  );
  check("манифест DONE", [...store.manifests.values()][0].status === "DONE");
  check("новая аудит-запись НЕ дописана (аудит вёл тот, кто исполнил)", store.audits.length === 1, store.audits.length);
}

console.log("\n[2] исполнение упало на стороне внешнего канала → отчёт честно показывает ошибку");
{
  const store = makeStore();
  const wrapped = withExternalConfirm(store, { error: "Drive API 403: insufficientFilePermissions" });
  const dec = await requireConsent({ tool: "drive_share", accountLabel: "personal", plan, rehash, store: wrapped, cfg: syncCfg });
  check("kind=already_executed", dec.kind === "already_executed", dec.kind);
  check("ошибка исполнения попала в отчёт", dec.report.includes("403"), dec.report.slice(-300));
  check("нет payload", !("payload" in dec));
}

console.log("\n[3] пруфа в аудите нет → честное «перепроверить не удалось», а не молчание");
{
  const store = makeStore({ withAudit: false }); // старый адаптер без read-метода
  const wrapped = withExternalConfirm(store);
  const dec = await requireConsent({ tool: "drive_share", accountLabel: "personal", plan, rehash, store: wrapped, cfg: syncCfg });
  check("kind=already_executed (ветка не падает без опционального метода)", dec.kind === "already_executed", dec.kind);
  check("сказано, что результат перепроверить не удалось", /перепроверить не удалось/.test(dec.report), dec.report.slice(-300));
  check("но повторять вызов всё равно не предлагается", /НЕ нужно|не нужно/.test(dec.report));
}

console.log("\n[4] отказ через веб в окне ожидания → по-прежнему refused");
{
  const store = makeStore();
  let polls = 0;
  const wrapped = {
    ...store,
    getManifest: async (id, server) => {
      polls++;
      if (polls === 2) await store.invalidateManifest(id, server, "нет, не надо");
      return store.getManifest(id, server);
    },
  };
  const dec = await requireConsent({ tool: "drive_share", accountLabel: "personal", plan, rehash, store: wrapped, cfg: syncCfg });
  check("kind=refused (настоящий отказ остаётся отказом)", dec.kind === "refused", dec.kind);
  check("манифест INVALIDATED", [...store.manifests.values()][0].status === "INVALIDATED");
}

console.log("\n[5] никто не ответил за окно → прежнее поведение: превью плана");
{
  const store = makeStore();
  const waitCfg = { ...cfg, syncWaitMs: 30, syncPollMs: 5, now: () => Date.now() };
  const dec = await requireConsent({ tool: "drive_share", accountLabel: "personal", plan, rehash, store, cfg: waitCfg });
  check("kind=planned", dec.kind === "planned", dec.kind);
  check("манифест жив (AWAITING_CONSENT)", [...store.manifests.values()][0].status === "AWAITING_CONSENT");
  check("аудит-читалка на этом пути не дёргалась", store.calls.audit === 0, store.calls.audit);
}

console.log("\n[6] статика: каждый call site отдаёт already_executed как отчёт с машинной меткой");
{
  const dir = new URL("../src/tools/", import.meta.url);
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => ["src/tools/" + f, readFileSync(new URL("../src/tools/" + f, import.meta.url), "utf8")]);
  let sites = 0;
  let handled = 0;
  let plainOk = 0;
  for (const [name, src] of files) {
    const lines = src.split("\n");
    lines.forEach((line, i) => {
      if (!/decision\.kind === "refused"/.test(line)) return;
      sites++;
      const window = lines.slice(Math.max(0, i - 4), i + 5).join("\n");
      if (/decision\.kind === "already_executed"/.test(window)) handled++;
      else console.log(`       не обработан already_executed: ${name}:${i + 1}`);
    });
    for (const m of src.matchAll(/decision\.kind === "already_executed"\)\s*return\s+(\w+)\(/g)) {
      if (m[1] !== "okExecutionReport") plainOk++;
    }
  }
  check("call site'ы найдены", sites > 0, sites);
  check(`все ${sites} call site'ов обрабатывают already_executed`, handled === sites, `${handled}/${sites}`);
  check("все отдают его через okExecutionReport (машинная метка исхода)", plainOk === 0, plainOk);
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
