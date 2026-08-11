/**
 * skill_version_update — auto-versioning for Claude skills stored on Google Drive.
 *
 * Layout on Drive:
 *   Skills/
 *     [skill_name]/
 *       [skill_name]_vX.X_YYYY-MM-DD.md   ← current (top-level)
 *       versions/
 *         [skill_name]_vX.Y_YYYY-MM-DD.md ← archived
 *
 * ГРАНИЦА «только внутри Skills/» (почему инструмент считается узким).
 * Захардкоженный `SKILLS_ROOT_FOLDER_ID` сам по себе границей НЕ является: до
 * фикса 2026-08-06 `skill_name` подставлялся в Drive-query без экранирования, и
 * значение с одинарной кавычкой дописывало вторую дизъюнкцию БЕЗ условия
 * `'<SKILLS_ROOT_FOLDER_ID>' in parents` — то есть уводило инструмент в любую
 * папку аккаунта (там он создаёт `versions/`, ПЕРЕМЕЩАЕТ туда найденный файл и
 * создаёт новый файл с содержимым, которое полностью контролирует модель).
 *
 * Теперь границу держат три независимых слоя, а не один:
 *   1. формат — `skill_name` проходит `SKILL_NAME_RE` (кавычка и обратный слэш
 *      физически невозможны), отказ до любого обращения к Drive;
 *   2. экранирование — всё, что подставляется в `q:`, идёт через
 *      `escapeDriveQueryValue()` (`\` перед `'`, а не только `'`);
 *   3. пост-проверка принадлежности — у найденной папки перечитываются
 *      `parents` и сверяются с `SKILLS_ROOT_FOLDER_ID`, а у архивируемого файла
 *      — со свежим `files.get` ПЕРЕД мутацией. Даже если строка запроса когда-
 *      нибудь снова окажется испорченной, мутация не выполнится.
 * Именно слой 3 (а не «id захардкожен») — то, чем обосновывается always_allow и
 * авто-исполнение по кнопке в Telegram.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ok, fail, guard, safeText, humanReadableAutoExecuteReport, escapeDriveQueryValue } from "../util.js";
import { buildUserClients, type UserClients } from "../accounts.js";
import { loadConfig } from "../config.js";
import {
  requireConsent,
  sha256,
  USER_REPLY_DOC,
  AUTOMATION_KEY_DOC,
  type ConsentStore,
} from "../consent.js";
import {
  type DriveConsentContext,
  DEFAULT_CONSENT_CTX,
  buildMutationResult,
} from "./drive.js";
import { registerAutoExecutor, type AutoExecutorCtx } from "../autoExecute.js";

const SKILLS_ROOT_FOLDER_ID = "1kjYll-ULT_Z1CFG80HcwgJR6AaS6CVg9";
const VERSIONS_FOLDER_NAME = "versions";
const ACCOUNT = "personal";

/**
 * Допустимый формат имени навыка = имени его папки в Skills/ и префикса имени
 * файла (`<skill_name>_vX.Y_YYYY-MM-DD.md`). Набор символов подобран по
 * реальным навыкам Максима (`email_management`, `mcp-development-standard`,
 * `ticktick-daily-review`): латиница, цифры, `_`, `-`. Кавычка, обратный слэш,
 * пробел и всё остальное запрещены — это первый слой защиты от инъекции в
 * Drive-query (`references/security-checklist.md` §2: идентификаторы из
 * аргументов валидируются по формату).
 */
const SKILL_NAME_RE = /^[A-Za-z0-9_-]{1,100}$/;

/** Лежит ли объект Drive непосредственно внутри папки `parentId`. Отсутствие
 * поля `parents` в ответе трактуется как «не лежит» (fail-closed): пустой ответ
 * НИКОГДА не должен читаться как разрешение. */
function isChildOf(file: { parents?: string[] | null } | null | undefined, parentId: string): boolean {
  return !!file && Array.isArray(file.parents) && file.parents.includes(parentId);
}

/** Compare semver-ish strings like "3.2" < "3.3" < "10.0". */
function versionGt(a: string, b: string): boolean {
  const parts = (v: string) => v.split(".").map((x) => parseInt(x, 10) || 0);
  const [aMaj, aMin = 0] = parts(a);
  const [bMaj, bMin = 0] = parts(b);
  return aMaj !== bMaj ? aMaj > bMaj : aMin > bMin;
}

/** Extract version string from filename like `email_management_v3.2_2026-06-30.md` → "3.2" */
function extractVersion(filename: string): string | null {
  const m = /_v(\d+\.\d+)_/.exec(filename);
  return m ? m[1] : null;
}

interface SkillVersionPayload {
  skill_name: string;
  new_version: string;
  new_content: string;
  newFileName: string;
}

/** Read-only resolution shared by plan/rehash/execute (gate.md §3.3(2)): finds
 * the skill folder, the current highest-version top-level file (if any), and
 * validates downgrade/collision. The IDENTICAL function on both sides of the
 * gate is what makes the binding a real drift check — e.g. someone else
 * already bumping the skill between plan and execute changes `currentFile`
 * and trips the mismatch, instead of silently archiving the WRONG version. */
async function resolveSkillState(
  g: ReturnType<UserClients["resolve"]>,
  skill_name: string,
  new_version: string,
  newFileName: string,
): Promise<
  | { ok: true; skillFolderId: string; currentFile: { id: string; name: string; version: string } | null }
  | { ok: false; error: string }
> {
  // ── Слой 1: формат имени. Отказ ДО любого обращения к Drive ───────────────
  if (!SKILL_NAME_RE.test(skill_name)) {
    return {
      ok: false,
      error:
        `Недопустимое имя навыка «${safeText(skill_name, 60)}». Разрешены только латинские буквы, ` +
        `цифры, дефис и подчёркивание (1–100 символов); кавычки, обратные слэши и пробелы запрещены — ` +
        `имя подставляется в поисковый запрос Google Drive. Ничего не искал и не менял.`,
    };
  }

  // ── Слой 2: экранирование при подстановке в запрос ────────────────────────
  const skillFolderRes = await g.drive.files.list({
    q: `name='${escapeDriveQueryValue(skill_name)}' and '${escapeDriveQueryValue(SKILLS_ROOT_FOLDER_ID)}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: "files(id,name,parents)",
    pageSize: 5,
  });
  const candidates = skillFolderRes.data.files ?? [];

  // ── Слой 3: пост-проверка принадлежности. Не доверяем тому, что фильтр в
  // строке запроса отработал: у КАЖДОГО кандидата сверяем имя и `parents` с
  // тем, что просили. Защита перестаёт зависеть от корректности строки. ──────
  const skillFolder = candidates.find(
    (f) => f.id && f.name === skill_name && isChildOf(f, SKILLS_ROOT_FOLDER_ID),
  );
  if (!skillFolder?.id) {
    if (candidates.length > 0) {
      return {
        ok: false,
        error:
          `Отказ: поиск папки навыка «${safeText(skill_name, 60)}» вернул объект, который НЕ лежит ` +
          `непосредственно внутри папки Skills (или называется иначе). Инструменту разрешено работать ` +
          `только внутри Skills/ — ничего не создано, не перемещено и не изменено.`,
      };
    }
    return { ok: false, error: `Skill folder "${skill_name}" not found inside Skills/. Create it first.` };
  }
  const skillFolderId = skillFolder.id;

  const topFilesRes = await g.drive.files.list({
    q: `'${escapeDriveQueryValue(skillFolderId)}' in parents and name contains '.md' and mimeType='text/plain' and trashed=false`,
    fields: "files(id,name,parents)",
    pageSize: 20,
  });
  // Та же пост-проверка для файлов-кандидатов на архивацию: в рассмотрение
  // попадают только те, кто реально лежит в папке навыка.
  const topFiles = (topFilesRes.data.files ?? []).filter((f) => isChildOf(f, skillFolderId));

  let currentFile: { id: string; name: string; version: string } | null = null;
  for (const f of topFiles) {
    if (!f.id || !f.name) continue;
    const v = extractVersion(f.name);
    if (!v) continue;
    if (!currentFile || versionGt(v, currentFile.version)) {
      currentFile = { id: f.id, name: f.name, version: v };
    }
  }

  if (currentFile && !versionGt(new_version, currentFile.version)) {
    return {
      ok: false,
      error: `Downgrade blocked: current version is ${currentFile.version}, requested new_version ${new_version} is not greater.`,
    };
  }

  const collision = topFiles.find((f) => f.name === newFileName);
  if (collision) {
    return { ok: false, error: `File "${newFileName}" already exists in the skill folder. Bump version or delete it first.` };
  }

  return { ok: true, skillFolderId, currentFile };
}

/** Shared binding-check logic used by BOTH the interactive gate
 * (`requireConsent`'s `rehash` inside the tool body below) and the
 * button-press auto-execute path (`registerAutoExecutor`'s `rehash`, called
 * by http.ts's poller with ONLY the manifest payload — no live client, see
 * `resolveAutoExecGoogleClients` below). Re-reads the skill folder state
 * fresh and hashes it the SAME way `plan()` computed the original
 * `objectHash` — any drift (someone else already bumped the skill, or a new
 * downgrade/collision appeared) trips a mismatch instead of trusting stale
 * data. Kept as ONE named function so the two call sites can never silently
 * diverge. */
async function rehashSkillVersion(
  g: ReturnType<UserClients["resolve"]>,
  addressing: SkillVersionPayload,
): Promise<string> {
  const state = await resolveSkillState(g, addressing.skill_name, addressing.new_version, addressing.newFileName);
  if (!state.ok) {
    // A drift that now makes the plan invalid (downgrade/collision appeared
    // since planning) must NOT silently match the old hash — hash something
    // that can never equal the plan-time value.
    return sha256({ error: state.error, ts: Date.now() });
  }
  return sha256({
    skill_name: addressing.skill_name,
    new_version: addressing.new_version,
    newFileName: addressing.newFileName,
    skillFolderId: state.skillFolderId,
    currentFile: state.currentFile,
  });
}

/**
 * Ядро исполнения `skill_version_update` — вынесено из тела тула (по образцу
 * gmail-mcp/src/tools/gmail.ts's `executeSendBatchCore`, коммит 6e236d6),
 * чтобы БЫТЬ ВЫЗЫВАЕМЫМ И ИЗ обычного MCP tool-хендлера (модель вызвала
 * execute второй раз), И ИЗ фонового авто-поллера (кнопка в Telegram сама
 * триггерит это, без участия модели вообще) — см. `autoExecute.ts`'s
 * doc-comment про то, почему это НЕ MCP-параметр, а отдельная функция.
 * Ничего в самой логике не изменилось — просто извлечена в функцию.
 */
async function executeSkillVersionCore(
  payload: SkillVersionPayload,
  auditId: string,
  consentStore: ConsentStore,
  g: ReturnType<UserClients["resolve"]>,
): Promise<CallToolResult> {
  const state = await resolveSkillState(g, payload.skill_name, payload.new_version, payload.newFileName);
  if (!state.ok) {
    await consentStore
      .updateConsentAuditOutcome(auditId, { outcome: "failed", error: state.error })
      .catch(() => {});
    return fail(state.error);
  }
  const { skillFolderId, currentFile } = state;

  // ── Identity-guard архивируемого файла — ДО любой мутации ─────────────
  // (mcp-development-standard §4): свежим запросом перечитываем сам файл и
  // убеждаемся, что он всё ещё называется так же и лежит внутри папки навыка
  // (которая уже доказана как подпапка Skills/). Перемещение чужого файла —
  // ровно то, что давала инъекция в поисковый запрос, поэтому проверка стоит
  // ДО создания `versions/`: отказ не должен оставлять за собой даже пустую
  // папку.
  if (currentFile) {
    const live = await g.drive.files
      .get({ fileId: currentFile.id, fields: "id,name,parents,trashed" })
      .then((res) => res.data)
      .catch(() => null);
    if (!live || live.name !== currentFile.name || live.trashed === true || !isChildOf(live, skillFolderId)) {
      const err =
        `Отказ: архивируемый файл «${safeText(currentFile.name, 80)}» при перепроверке не найден в папке ` +
        `навыка «${safeText(payload.skill_name, 60)}» (переименован, удалён или лежит в другой папке). ` +
        `Ничего не перемещено и не создано — построй план заново.`;
      await consentStore.updateConsentAuditOutcome(auditId, { outcome: "failed", error: err }).catch(() => {});
      return fail(err);
    }
  }

  // ── Find or create versions/ subfolder ──────────────────────────────
  let versionsFolderId: string;
  try {
    const vfRes = await g.drive.files.list({
      q: `name='${escapeDriveQueryValue(VERSIONS_FOLDER_NAME)}' and '${escapeDriveQueryValue(skillFolderId)}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      fields: "files(id,name,parents)",
      pageSize: 2,
    });
    // Та же пост-проверка: принимаем только реальную подпапку `versions/`
    // ИМЕННО этой папки навыка — иначе файл уехал бы в чужую папку.
    const existingVersions = (vfRes.data.files ?? []).find(
      (f) => f.id && f.name === VERSIONS_FOLDER_NAME && isChildOf(f, skillFolderId),
    );
    if (existingVersions?.id) {
      versionsFolderId = existingVersions.id;
    } else {
      const created = await g.drive.files.create({
        requestBody: {
          name: VERSIONS_FOLDER_NAME,
          mimeType: "application/vnd.google-apps.folder",
          parents: [skillFolderId],
        },
        fields: "id",
      });
      if (!created.data.id) throw new Error("Failed to create versions/ folder.");
      versionsFolderId = created.data.id;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await consentStore.updateConsentAuditOutcome(auditId, { outcome: "failed", error: msg }).catch(() => {});
    return fail(msg);
  }

  // ── Archive current file → versions/ ─────────────────────────────────
  let archivedFile: { id: string; name: string } | null = null;
  if (currentFile) {
    await g.drive.files.update({
      fileId: currentFile.id,
      addParents: versionsFolderId,
      removeParents: skillFolderId,
      fields: "id,parents",
    });
    archivedFile = { id: currentFile.id, name: currentFile.name };
  }

  // ── Create new file at top level ──────────────────────────────────────
  let newFileId: string | null = null;
  let error: string | undefined;
  try {
    const { Readable } = await import("node:stream");
    const created = await g.drive.files.create({
      requestBody: {
        name: payload.newFileName,
        mimeType: "text/plain",
        parents: [skillFolderId],
      },
      media: {
        mimeType: "text/plain",
        body: Readable.from([payload.new_content]),
      },
      fields: "id",
    });
    if (!created.data.id) throw new Error("Drive did not return file id.");
    newFileId = created.data.id;
  } catch (err) {
    const hint = archivedFile
      ? ` Archived file is at versions/${archivedFile.name} (id: ${archivedFile.id}) — move it back manually if needed.`
      : "";
    error = `Failed to create new file: ${(err as Error).message}.${hint}`;
  }

  return buildMutationResult({
    results: [{ newFileId, newFileName: payload.newFileName, skillFolderId, archivedFile, error }],
    total: 1,
    verb: "Обновлено",
    summaryIcon: "✅",
    verify: async (r) => {
      const meta = await g.drive.files
        .get({ fileId: r.newFileId ?? "", fields: "id,name,parents" })
        .then((res) => res.data)
        .catch(() => null);
      const lbl = safeText(r.newFileName) || "(файл)";
      if (!meta) return { outcome: "warn", line: `- ⚠️ **«${lbl}»** — не удалось перепроверить новый файл` };
      // Пруф включает и принадлежность: «файл существует» без «и лежит там,
      // где обещали» — не доказательство границы Skills/.
      if (!isChildOf(meta, r.skillFolderId)) {
        return {
          outcome: "mismatch",
          line: `- ❌ **«${safeText(meta.name ?? lbl)}»** — новый файл лежит НЕ в папке навыка ${safeText(payload.skill_name)}`,
        };
      }
      return { outcome: "ok", line: `- ✅ **«${safeText(meta.name ?? lbl)}»** — новый файл существует в Skills/${safeText(payload.skill_name)}` };
    },
    reportTitle: "Независимая проверка обновления навыка",
    reportSubtitle: "запрошено ⇄ живые файлы Drive",
    consentStore,
    auditId,
  });
}

/** Builds a Google client for the fixed `personal` account WITHOUT a live
 * per-request `userClients` instance. Needed because `registerAutoExecutor`
 * below runs at module scope (once, on import) and its `rehash` callback is
 * invoked by http.ts's poller with ONLY the manifest payload — no ctx (see
 * `RehashFn` in autoExecute.ts; `execute` below gets `ctx.clients` for free,
 * `rehash` does not). Mirrors the SAME fallback http.ts's own
 * `runAutoExecutePoller` falls back to when no onboarded account is available
 * (`config.users[0]`) — consistent with `ACCOUNT` already being a fixed,
 * env-configured account name rather than a per-user onboarded label. */
function resolveAutoExecGoogleClients(): ReturnType<UserClients["resolve"]> {
  const user = loadConfig().users[0];
  if (!user) {
    throw new Error(
      "skill_version_update auto-execute: нет настроенного Google-пользователя (GOOGLE_OAUTH_* / GOOGLE_ACCOUNTS).",
    );
  }
  return buildUserClients(user).resolve(ACCOUNT);
}

registerAutoExecutor("skill_version_update", {
  rehash: (addressing) => rehashSkillVersion(resolveAutoExecGoogleClients(), addressing as SkillVersionPayload),
  execute: async (payload, auditId, ctx: AutoExecutorCtx) => {
    const p = payload as SkillVersionPayload;
    const g = ctx.clients.resolve(ACCOUNT);
    const result = await executeSkillVersionCore(p, auditId, ctx.consentStore, g);
    return humanReadableAutoExecuteReport(result);
  },
});

export function registerSkillVersionTools(server: McpServer, userClients: UserClients, ctx: DriveConsentContext = DEFAULT_CONSENT_CTX) {
  server.registerTool(
    "skill_version_update",
    {
      title: "Update skill version on Drive",
      description:
        "Archive the current skill file to versions/ and create a new version. " +
        "Operates only inside Skills/ folder. Guards against downgrade and name collisions. Two-mode " +
        "consent-gated tool (mcp-development-standard/references/gate.md): call WITHOUT `manifest_id`/" +
        "`user_reply` (with `skill_name`/`new_version`/`new_content`) to build a plan and return a preview — " +
        "NOTHING is archived or created yet. Show the preview to the user verbatim and wait for their reply. " +
        "Call again with the returned `manifest_id` and the user's VERBATIM `user_reply` to actually update.",
      inputSchema: {
        skill_name: z.string().optional().describe("Skill folder name, e.g. 'email_management'. Required to build a plan (first call)."),
        new_version: z.string().optional().describe("New version string, e.g. '3.3'. Required to build a plan (first call)."),
        new_content: z.string().optional().describe("Full markdown content of the new skill file. Required to build a plan (first call)."),
        date: z.string().optional().describe("Date override YYYY-MM-DD (default: today)."),
        manifest_id: z
          .string()
          .optional()
          .describe("Id of a plan built by a previous no-argument call. Pass together with `user_reply` to execute it."),
        user_reply: z.string().optional().describe(USER_REPLY_DOC),
        automation_key: z.string().optional().describe(AUTOMATION_KEY_DOC),
      },
      annotations: { destructiveHint: false },
    },
    guard(async ({ skill_name, new_version, new_content, date, manifest_id, user_reply, automation_key }) => {
      const { consentStore, consentCfg, tg, checkAutomationKey } = ctx;
      if (!consentStore) {
        return fail(
          "Обновление версии навыка недоступно: не настроено хранилище согласия (DATABASE_URL). Без него " +
            "сервер не может провести это действие через гейт подтверждения — обратитесь к администратору сервера.",
        );
      }
      const g = userClients.resolve(ACCOUNT);
      const today = date ?? new Date().toISOString().slice(0, 10);

      const decision = await requireConsent<SkillVersionPayload>({
        tool: "skill_version_update",
        accountLabel: ACCOUNT,
        manifestId: manifest_id,
        userReply: user_reply,
        store: consentStore,
        cfg: consentCfg,
        tg,
        automationKey: automation_key,
        checkAutomationKey,
        plan: async () => {
          if (!skill_name || !new_version || new_content === undefined) {
            throw new Error("Нужны `skill_name`, `new_version` и `new_content`, чтобы построить план.");
          }
          const newFileName = `${skill_name}_v${new_version}_${today}.md`;
          const state = await resolveSkillState(g, skill_name, new_version, newFileName);
          if (!state.ok) throw new Error(state.error);
          const payload: SkillVersionPayload = { skill_name, new_version, new_content, newFileName };
          const preview =
            `### 📤 План: Обновление навыка «${safeText(skill_name, 60)}»\n\n` +
            (state.currentFile
              ? `- **«${safeText(state.currentFile.name, 80)}»** (v${state.currentFile.version}) → архив в versions/\n`
              : `- Текущей версии нет — архивировать нечего\n`) +
            `- **«${safeText(newFileName, 80)}»** — новый файл (${new_content.length} симв.)`;
          const objectHash = sha256({
            skill_name,
            new_version,
            newFileName,
            skillFolderId: state.skillFolderId,
            currentFile: state.currentFile,
          });
          return { payload, objectHash, preview };
        },
        rehash: (addressing) => rehashSkillVersion(g, addressing as SkillVersionPayload),
      });

      if (decision.kind === "planned") return ok(decision.preview);
      if (decision.kind === "refused") return ok(decision.result);

      const { payload, auditId } = decision;
      return executeSkillVersionCore(payload, auditId, consentStore, g);
    }),
  );
}
