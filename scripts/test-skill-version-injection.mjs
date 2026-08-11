#!/usr/bin/env node
/**
 * Инъекция в Drive-query через `skill_name` (skill_version_update) — регресс-тест.
 *
 * УЯЗВИМОСТЬ, которую он закрывает (была в src/tools/skill_version.ts до
 * 2026-08-06): `skill_name` приходит аргументом от модели и подставлялся в
 * строку поиска Drive без экранирования одинарной кавычки:
 *
 *   q: `name='${skill_name}' and '<SKILLS_ROOT>' in parents and mimeType=… `
 *
 * В языке Drive-query `and` приоритетнее `or`, поэтому значение вида
 *   zzz' and trashed=false or '<ЧУЖАЯ_ПАПКА>' in parents and mimeType='…folder' and name!='
 * разбивает условие на две дизъюнкции, и во ВТОРОЙ нет `'<SKILLS_ROOT>' in
 * parents`. Ограничение «только внутри папки Skills» снималось, и инструмент
 * дальше в ЧУЖОЙ папке создавал `versions/`, ПЕРЕМЕЩАЛ туда найденный чужой
 * файл и создавал новый файл с содержимым, которое полностью контролирует
 * модель. Инструмент при этом помечен как безопасный для always_allow и имеет
 * путь авто-исполнения по кнопке в Telegram.
 *
 * Проверяются ТРИ независимых слоя защиты, каждый — отдельным сценарием, чтобы
 * при снятии любого одного краснел свой тест:
 *   [1] экранирование  — `escapeDriveQueryValue()` (сначала `\`, потом `'`);
 *   [2] формат имени   — `SKILL_NAME_RE`, отказ ДО обращения к Drive;
 *   [3] пост-проверка  — у найденной папки и у архивируемого файла сверяются
 *                        `parents`, даже если строка запроса «сработала».
 *
 * Живой Google API не трогается: всё на фейковом Drive-клиенте, который к тому
 * же ЭМУЛИРУЕТ УЯЗВИМЫЙ ПАРСЕР (если в `q` осталась неэкранированная кавычка,
 * разрывающая литерал, — мок отдаёт чужую папку, как отдал бы настоящий Drive).
 *
 * Usage: node scripts/test-skill-version-injection.mjs
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerSkillVersionTools } from "../dist/tools/skill_version.js";
import { escapeDriveQueryValue } from "../dist/util.js";

let failures = 0;
const check = (label, cond, extra = "") => {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${label}${cond ? "" : ` — got: ${extra}`}`);
  if (!cond) failures++;
};
const text = (r) => r.content[0].text;

// Тот же id, что захардкожен в src/tools/skill_version.ts.
const SKILLS_ROOT = "1kjYll-ULT_Z1CFG80HcwgJR6AaS6CVg9";
const SKILL_FOLDER = "SKILLFOLDER_legit";
const FOREIGN_FOLDER = "FOREIGN_FOLDER_XYZ"; // «чужая» папка вне Skills/
const FOREIGN_PARENT = "MY_DRIVE_ROOT";

/** Полезная нагрузка из разведки: закрывает литерал и дописывает свою
 * дизъюнкцию БЕЗ условия «внутри Skills». */
const INJECTION =
  `zzz' and trashed=false or '${FOREIGN_FOLDER}' in parents and ` +
  `mimeType='application/vnd.google-apps.folder' and name!='`;

// ── фейковый Drive ─────────────────────────────────────────────────────────

/**
 * @param scenario.skillFolders     что вернуть на поиск папки навыка
 * @param scenario.versionsFolders  что вернуть на поиск versions/
 * @param scenario.topFiles         что вернуть на поиск .md-файлов
 * @param scenario.getOverrides     подмена ответа files.get по id
 */
function buildClients(counters, scenario) {
  const world = new Map(); // id → метаданные (для files.get)
  for (const f of [...(scenario.skillFolders ?? []), ...(scenario.versionsFolders ?? []), ...(scenario.topFiles ?? [])]) {
    world.set(f.id, { ...f, trashed: false });
  }
  return {
    names: ["personal"],
    defaultName: "personal",
    multi: false,
    resolve: () => ({
      drive: {
        files: {
          list: async ({ q }) => {
            counters.list++;
            counters.queries.push(String(q));
            // ЭМУЛЯЦИЯ УЯЗВИМОГО ПАРСЕРА: неэкранированная кавычка разорвала
            // литерал и «or» отработал → Drive вернул объект из чужой папки.
            // При корректном экранировании тут стоит `\'`, и ветка не срабатывает.
            if (String(q).includes("' and trashed=false or '")) {
              counters.injectionFired++;
              return { data: { files: [{ id: FOREIGN_FOLDER, name: "Финансы 2026", parents: [FOREIGN_PARENT] }] } };
            }
            if (String(q).includes(`name='${escapeDriveQueryValue("versions")}'`)) {
              return { data: { files: scenario.versionsFolders ?? [] } };
            }
            if (String(q).includes("name contains '.md'")) {
              return { data: { files: scenario.topFiles ?? [] } };
            }
            if (String(q).includes(`'${SKILLS_ROOT}' in parents`)) {
              return { data: { files: scenario.skillFolders ?? [] } };
            }
            return { data: { files: [] } };
          },
          get: async ({ fileId }) => {
            counters.get++;
            const override = scenario.getOverrides?.[fileId];
            if (override === null) throw new Error("not found");
            const data = override ?? world.get(fileId);
            if (!data) throw new Error("not found");
            return { data: { ...data } };
          },
          create: async ({ requestBody }) => {
            counters.create++;
            counters.created.push({ name: requestBody?.name, parents: requestBody?.parents });
            const id = "NEW" + counters.create;
            world.set(id, { id, name: requestBody?.name ?? "new", parents: requestBody?.parents ?? [], trashed: false });
            return { data: { id, name: requestBody?.name ?? "new" } };
          },
          update: async (args) => {
            counters.update++;
            counters.updated.push({ fileId: args.fileId, addParents: args.addParents, removeParents: args.removeParents });
            return { data: { id: args.fileId, parents: [args.addParents] } };
          },
        },
      },
      accessToken: async () => "ya29.FAKE",
    }),
    baseGmailQuery: () => "",
  };
}

function makeCounters() {
  return { list: 0, get: 0, create: 0, update: 0, injectionFired: 0, queries: [], created: [], updated: [] };
}

// ── фейковый consent-store с РАБОЧИМ одноразовым consumeManifest ───────────

function makeConsentStore() {
  const manifests = new Map();
  const audits = [];
  return {
    manifests,
    audits,
    async createManifest(i) {
      manifests.set(i.id, { ...i, status: "AWAITING_CONSENT", consumedAt: null, userReply: null });
    },
    async getManifest(id, server) {
      const r = manifests.get(id);
      return r && r.server === server ? { ...r } : null;
    },
    async consumeManifest(id, server, userReply) {
      const r = manifests.get(id);
      if (!r || r.server !== server || r.status !== "AWAITING_CONSENT" || r.expiresAt <= Date.now()) return null;
      r.status = "DONE";
      r.consumedAt = Date.now();
      r.userReply = userReply;
      return { ...r };
    },
    async invalidateManifest(id) {
      const r = manifests.get(id);
      if (r) r.status = "INVALIDATED";
    },
    async appendConsentAudit(e) {
      audits.push(e);
    },
    async updateConsentAuditOutcome(id, outcome) {
      audits.push({ id, ...outcome });
    },
  };
}

// minConsentGapMs=0: анти-дуплет здесь не тестируется (у него свой тест),
// а happy-path должен доходить до реальной мутации.
const CONSENT_CFG = { server: "drive", consentTtlMs: 3_600_000, minConsentGapMs: 0, sendBatchMax: 10 };

async function harness(scenario) {
  const counters = makeCounters();
  const clients = buildClients(counters, scenario);
  const consentStore = makeConsentStore();
  const server = new McpServer({ name: "skill-version-injection", version: "0" });
  registerSkillVersionTools(server, clients, { consentStore, consentCfg: CONSENT_CFG, auditStore: null });
  const cli = new Client({ name: "c", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), cli.connect(a)]);
  return { cli, counters, consentStore };
}

const call = (cli, args) => cli.callTool({ name: "skill_version_update", arguments: args });
const manifestIdOf = (body) => (/_план `([^`]+)`/.exec(body) ?? [])[1];

/**
 * true, если строковый литерал `name='<esc(value)>'` закрывается РОВНО своей
 * последней кавычкой (значение не «вырвалось» из литерала). Ровно та проверка,
 * которую ломает и «не экранируем кавычку», и «экранируем только кавычку, но
 * не обратный слэш».
 */
function literalIsIntact(value) {
  const q = `name='${escapeDriveQueryValue(value)}'`;
  let i = "name='".length;
  while (i < q.length) {
    if (q[i] === "\\") {
      i += 2;
      continue;
    }
    if (q[i] === "'") break;
    i++;
  }
  return i === q.length - 1;
}

// ═══ [1] экранирование само по себе (юнит) ═════════════════════════════════

console.log("\n[1] escapeDriveQueryValue: кавычка и обратный слэш обезврежены");
check("кавычка экранируется", escapeDriveQueryValue("a'b") === "a\\'b", escapeDriveQueryValue("a'b"));
check("обратный слэш экранируется", escapeDriveQueryValue("legit\\") === "legit\\\\", escapeDriveQueryValue("legit\\"));
check("порядок замен верный (слэш ДО кавычки)", escapeDriveQueryValue("a\\'b") === "a\\\\\\'b", escapeDriveQueryValue("a\\'b"));
check("литерал не рвётся на значении с кавычкой", literalIsIntact("a'b"));
check("литерал не рвётся на значении, кончающемся на обратный слэш", literalIsIntact("legit\\"));
check("литерал не рвётся на полной инъекционной нагрузке", literalIsIntact(INJECTION));
check(
  "экранированная нагрузка НЕ триггерит уязвимый парсер мока",
  !`name='${escapeDriveQueryValue(INJECTION)}'`.includes("' and trashed=false or '"),
);
check(
  "контроль: НЕэкранированная нагрузка уязвимый парсер мока триггерит",
  `name='${INJECTION}'`.includes("' and trashed=false or '"),
);

// ═══ [2] инъекция через сам инструмент ═════════════════════════════════════

console.log("\n[2] инъекционный `skill_name` → отказ, ни одного запроса в Drive, ноль мутаций");
{
  const { cli, counters } = await harness({
    skillFolders: [{ id: SKILL_FOLDER, name: "legit_skill", parents: [SKILLS_ROOT] }],
  });
  const body = text(await call(cli, { skill_name: INJECTION, new_version: "9.9", new_content: "# pwned" }));
  check("инструмент отказал (не построил план)", !body.includes("### 📤 План"), body.slice(0, 80));
  check("отказ объясняет причину (недопустимое имя)", /Недопустимое имя навыка/.test(body), body.slice(0, 120));
  check("ни одного запроса в Drive не ушло", counters.list === 0, String(counters.list));
  check("уязвимый парсер мока не сработал ни разу", counters.injectionFired === 0, String(counters.injectionFired));
  check("files.create не вызывался", counters.create === 0, String(counters.create));
  check("files.update не вызывался", counters.update === 0, String(counters.update));
  check(
    "ни в одном ушедшем q нет неэкранированной кавычки из нагрузки",
    counters.queries.every((q) => !q.includes("' and trashed=false or '")),
    counters.queries.join(" | ").slice(0, 120),
  );
}

console.log("\n[3] `skill_name`, кончающийся на обратный слэш → отказ, ноль мутаций");
{
  const { cli, counters } = await harness({
    skillFolders: [{ id: SKILL_FOLDER, name: "legit_skill", parents: [SKILLS_ROOT] }],
  });
  const body = text(await call(cli, { skill_name: "legit_skill\\", new_version: "9.9", new_content: "x" }));
  check("инструмент отказал", !body.includes("### 📤 План"), body.slice(0, 80));
  check("отказ объясняет причину", /Недопустимое имя навыка/.test(body), body.slice(0, 120));
  check("ни одного запроса в Drive", counters.list === 0, String(counters.list));
  check("ноль мутаций", counters.create === 0 && counters.update === 0, `${counters.create}/${counters.update}`);
}

// ═══ [4] пост-проверка parents — САМА ПО СЕБЕ ══════════════════════════════
// Имя валидное (слои 1-2 пропускают), но Drive ВОЗВРАЩАЕТ папку вне Skills/ —
// имитация того, что фильтр по строке запроса как-то обойдён. Ключевой тест:
// защита не должна держаться только на строке запроса.

console.log("\n[4] Drive вернул папку ВНЕ Skills/ → отказ, ноль мутаций (пост-проверка parents)");
{
  const { cli, counters } = await harness({
    skillFolders: [{ id: FOREIGN_FOLDER, name: "legit_skill", parents: [FOREIGN_PARENT] }],
    topFiles: [{ id: "FOREIGN_FILE", name: "legit_skill_v1.0_2026-01-01.md", parents: [FOREIGN_PARENT] }],
  });
  const body = text(await call(cli, { skill_name: "legit_skill", new_version: "9.9", new_content: "# pwned" }));
  check("запрос в Drive реально уходил (бьём именно по пост-проверке)", counters.list > 0, String(counters.list));
  check("инструмент отказал", !body.includes("### 📤 План"), body.slice(0, 80));
  check("отказ ссылается на границу Skills/", /Skills/.test(body), body.slice(0, 160));
  check("files.create не вызывался", counters.create === 0, String(counters.create));
  check("files.update не вызывался", counters.update === 0, String(counters.update));
}

console.log("\n[4b] Drive вернул папку внутри Skills/, но с ДРУГИМ именем → отказ");
{
  const { cli, counters } = await harness({
    skillFolders: [{ id: "OTHER_SKILL", name: "someone_elses_skill", parents: [SKILLS_ROOT] }],
  });
  const body = text(await call(cli, { skill_name: "legit_skill", new_version: "9.9", new_content: "# pwned" }));
  check("инструмент отказал", !body.includes("### 📤 План"), body.slice(0, 80));
  check("ноль мутаций", counters.create === 0 && counters.update === 0, `${counters.create}/${counters.update}`);
}

// ═══ [5] пост-проверка файла ПЕРЕД перемещением ════════════════════════════
// План строится честно, но к моменту исполнения свежий files.get показывает,
// что файл лежит в другой папке (подмена/дрейф). Перемещать нельзя.

console.log("\n[5] архивируемый файл при перепроверке оказался вне папки навыка → отказ, ноль мутаций");
{
  const cur = { id: "CUR1", name: "legit_skill_v1.0_2026-01-01.md", parents: [SKILL_FOLDER] };
  const { cli, counters } = await harness({
    skillFolders: [{ id: SKILL_FOLDER, name: "legit_skill", parents: [SKILLS_ROOT] }],
    topFiles: [cur],
    versionsFolders: [{ id: "VERSIONS1", name: "versions", parents: [SKILL_FOLDER] }],
    // files.get отдаёт ДРУГОГО родителя, чем list — то, что должно ловиться.
    getOverrides: { CUR1: { id: "CUR1", name: cur.name, parents: [FOREIGN_PARENT], trashed: false } },
  });
  const plan = text(await call(cli, { skill_name: "legit_skill", new_version: "9.9", new_content: "# new", date: "2026-08-06" }));
  check("план построен", plan.includes("### 📤 План"), plan.slice(0, 80));
  const id = manifestIdOf(plan);
  check("manifest_id извлечён", !!id, plan.slice(-120));
  const body = text(await call(cli, { manifest_id: id, user_reply: "да" }));
  check("исполнение отклонено", /Отказ: архивируемый файл/.test(body), body.slice(0, 160));
  check("файл НЕ перемещён (files.update = 0)", counters.update === 0, String(counters.update));
  check("новый файл НЕ создан (files.create = 0)", counters.create === 0, String(counters.create));
}

// ═══ [6] happy path — регрессия не сломана ════════════════════════════════

console.log("\n[6] нормальный путь: валидное имя, папка внутри Skills/ → план и исполнение работают");
{
  const cur = { id: "CUR1", name: "legit_skill_v1.0_2026-01-01.md", parents: [SKILL_FOLDER] };
  const { cli, counters } = await harness({
    skillFolders: [{ id: SKILL_FOLDER, name: "legit_skill", parents: [SKILLS_ROOT] }],
    topFiles: [cur],
    versionsFolders: [{ id: "VERSIONS1", name: "versions", parents: [SKILL_FOLDER] }],
  });
  const plan = text(await call(cli, { skill_name: "legit_skill", new_version: "2.0", new_content: "# new", date: "2026-08-06" }));
  check("план построен", plan.includes("### 📤 План"), plan.slice(0, 80));
  check("в плане видна архивируемая версия", plan.includes("v1.0"), plan.slice(0, 200));
  check("на фазе плана ноль мутаций", counters.create === 0 && counters.update === 0, `${counters.create}/${counters.update}`);
  check(
    "имя навыка ушло в q корректно экранированным",
    counters.queries.some((q) => q.includes("name='legit_skill' and")),
    counters.queries[0]?.slice(0, 100),
  );

  const id = manifestIdOf(plan);
  const body = text(await call(cli, { manifest_id: id, user_reply: "да" }));
  check("исполнение прошло (заголовок успеха)", body.includes("✅"), body.slice(0, 120));
  check("старый файл перемещён ровно один раз", counters.update === 1, String(counters.update));
  check(
    "перемещение именно из папки навыка в versions/",
    counters.updated[0]?.addParents === "VERSIONS1" && counters.updated[0]?.removeParents === SKILL_FOLDER,
    JSON.stringify(counters.updated[0]),
  );
  check("новый файл создан ровно один раз", counters.create === 1, String(counters.create));
  check(
    "новый файл создан в папке навыка с ожидаемым именем",
    counters.created[0]?.name === "legit_skill_v2.0_2026-08-06.md" && counters.created[0]?.parents?.[0] === SKILL_FOLDER,
    JSON.stringify(counters.created[0]),
  );
  check("пруф-блок post-verify присутствует", body.includes("🧾"), body.slice(-200));
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
