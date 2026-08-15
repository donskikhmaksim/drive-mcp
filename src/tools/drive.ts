/**
 * Google Drive tools (search / organise files).
 * All mutating tools accept arrays of items and process them in parallel.
 */
import { z } from "zod";
import { Readable } from "node:stream";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ok, fail, guard, isTextual, safeText, mapWithLimit, humanReadableAutoExecuteReport, okExecutionReport } from "../util.js";
import { accountField, type UserClients } from "../accounts.js";
import type { GoogleClients } from "../google.js";
import { documentToPlainText } from "./docs.js";
import {
  issueDownloadLink,
  resolveDownloadLink,
  downloadsAvailable,
  DEFAULT_TTL_MINUTES,
  MAX_TTL_MINUTES,
} from "../downloads.js";
import { rememberUploadSession, resolveUploadSession } from "../uploadSessions.js";
import { safeGoogleFetch, assertAllowedGoogleUrl, BlockedUrlError } from "../safeFetch.js";
import {
  requireConsent,
  sha256,
  formatLaTime,
  USER_REPLY_DOC,
  AUTOMATION_KEY_DOC,
  type ConsentStore,
  type ConsentConfig,
  type ConsentAddressing,
} from "../consent.js";
import type { TgApprovalGate } from "../tg_approval.js";
import { registerAutoExecutor, type AutoExecutorCtx } from "../autoExecute.js";

// ── Consent-gate context (shared across drive.ts/docs.ts/skill_version.ts) ──
// mcp-development-standard/references/gate.md. Defined here (drive.ts, the
// main tool file) and re-exported so the other two tool files in this repo
// thread the SAME context/adapters through — server.ts builds one instance
// and passes it to all three register*Tools calls.

/** One row of the shared consent_audit log, as read by `drive_consent_audit`.
 * Mirrors store.ts's `ConsentAuditRow` structurally — same "don't import
 * store.ts directly, context provides adapters" convention as elsewhere;
 * `server.ts` wires the real implementation in. */
export interface ConsentAuditRow {
  id: string;
  ts: number;
  tool: string;
  accountLabel: string;
  manifestId?: string | null;
  objectHash?: string | null;
  userReply: string;
  outcome: string;
  refusalReason?: string | null;
  actor: string;
  postVerifyResult: string | null;
  error: string | null;
  preSnapshot: unknown;
}

export interface ConsentAuditFilters {
  server: string;
  since?: number;
  until?: number;
  accountLabel?: string;
  tool?: string;
  outcome?: string;
}

/** Read-only access to the consent-gate audit log — "разбор инцидента без
 * ssh" (limits-audit.md §11). Separate from `ConsentStore` above: this is
 * neither the plan nor the execute gate, just a read path over the same
 * consent_audit table the gate already writes to. */
export interface AuditStore {
  listConsentAudit(filters: ConsentAuditFilters, limit?: number, offset?: number): Promise<ConsentAuditRow[]>;
  countConsentAudit(filters: ConsentAuditFilters): Promise<number>;
}

/** Context threaded into `registerDriveTools`/`registerDocsTools`/
 * `registerSkillVersionTools` carrying the consent-gate wiring (ported from
 * gmail-mcp's `GmailSnoozeContext` / sheets-mcp's `SheetsConsentContext`). */
export interface DriveConsentContext {
  /** Consent-gate storage. null exactly when Postgres isn't configured —
   * every gated write tool below refuses outright when this is null
   * (gate.md §3.5: no durable manifest storage means no gate, and that must
   * never become a silent bypass). */
  consentStore: ConsentStore | null;
  /** Gate knobs (TTL / anti-doublet gap / batch cap), always present even
   * when consentStore is null so a refusal message can still be built
   * without a crash. Real value comes from `consentServerConfig` in
   * server.ts (env-driven). */
  consentCfg: ConsentConfig;
  /** Read-only access to the consent_audit log. null exactly when Postgres
   * isn't configured (same honest-degradation rule as `consentStore`). */
  auditStore: AuditStore | null;
  /**
   * Optional out-of-band Telegram-button approval gate (`../tg_approval.js`,
   * plan-tg-approval.md). undefined/absent behaves exactly as if this field
   * didn't exist — `enabledFor()` is false for every tool when the feature is
   * off (TG_APPROVAL_ENABLED unset), so a fork without a configured bot is
   * unaffected.
   *
   * WIRED (as of the auto-execute-by-button pass, 2026-08-05): `../consent.js`
   * has the `tg?: TgApprovalGate` field on `RequireConsentParams` and the
   * `p.tg?.enabledFor(tool)` branches inside `requireConsent()`, and every
   * `requireConsent({ ... })` call in this file below destructures `tg` from
   * `ctx` and passes it through (`tg,` shorthand). Setting
   * TG_APPROVAL_ENABLED=true does have runtime effect here.
   */
  tg?: TgApprovalGate;
  /**
   * Optional DI for the automation_key fast path (`../consent.js`'s
   * `RequireConsentParams.checkAutomationKey`, ТЗ
   * `TZ_automation_key_consent_gate.md`). undefined behaves exactly as if
   * this field didn't exist — the branch inside `requireConsent()` is never
   * entered, byte-identical to pre-automation_key behaviour. Real value comes
   * from `../automationKey.js`'s `checkAutomationKey`, wired in server.ts.
   */
  checkAutomationKey?: (key: string, tool: string) => Promise<{ ok: boolean; channel?: string }>;
}

/** Fallback gate config for callers that don't wire a real one (offline unit
 * tests exercising other tools). Mirrors config.ts's `loadConsentGateConfig()`
 * defaults; production always gets the real env-driven config from server.ts. */
const DEFAULT_CONSENT_CFG: ConsentConfig = {
  server: "drive",
  consentTtlMs: 3_600_000,
  minConsentGapMs: 2_000,
  sendBatchMax: 10,
};

export const DEFAULT_CONSENT_CTX: DriveConsentContext = {
  consentStore: null,
  consentCfg: DEFAULT_CONSENT_CFG,
  auditStore: null,
};

// ── Consent-gate machinery (mcp-development-standard/references/gate.md) ───
// Ported from sheets-mcp's tools/sheets.ts: the same requireConsent/
// plan→execute wiring, one §5.3 report renderer, and REAL (non-tautological)
// rehash for every gated write below — each rehash re-reads the LIVE target
// (file metadata / parents / permissions) at execute time, never
// `sha256(payload)` in disguise, except where explicitly noted (creating a
// brand-new object — folder/small-file upload/upload-session-for-a-new-file
// — has no live object to bind against yet, the same documented degenerate
// case as gmail_send/sheets_create).

export type PostVerifyOutcome = "ok" | "warn" | "mismatch";
export interface VerifyLine {
  outcome: PostVerifyOutcome;
  line: string;
}

/** Now, formatted for America/Los_Angeles. */
export function nowInLA(): string {
  return new Date().toLocaleString("sv-SE", { timeZone: "America/Los_Angeles" }) + " America/Los_Angeles";
}

/** Worst outcome across a batch, for choosing the summary status header. */
export function worstOutcome(results: Array<{ outcome: PostVerifyOutcome }>): PostVerifyOutcome {
  if (results.some((r) => r.outcome === "mismatch")) return "mismatch";
  if (results.some((r) => r.outcome === "warn")) return "warn";
  return "ok";
}

/** One §5.3 renderer for the whole repo (output-format.md §7.1 p.5: "an
 * instrument hand-rolling its own status string is a defect"). Exported so
 * docs.ts/skill_version.ts use the identical renderer. */
export function renderVerifyReport(title: string, subtitle: string, results: VerifyLine[]): string {
  const okN = results.filter((r) => r.outcome === "ok").length;
  const warnN = results.filter((r) => r.outcome === "warn").length;
  const mmN = results.filter((r) => r.outcome === "mismatch").length;
  const body = results.map((r) => r.line).join("\n");
  return (
    `### 🧾 ${title}\n` +
    `_${nowInLA()} · ${subtitle}_\n\n` +
    `${body}\n\n` +
    `**Итог: ✅ ${okN} подтверждено, ⚠️ ${warnN} не проверено, ❌ ${mmN} расхождение.**\n` +
    `_[агенту: перепечатай этот отчёт пользователю ДОСЛОВНО — это серверная проверка, не заменяй пересказом]_`
  );
}

/**
 * Aggregates a gated batch mutation's per-item results with REAL independent
 * post-verify reads: every item without an execute-time `error` gets a fresh
 * `verify` read, the response header reflects the WORST outcome (never
 * smoothed to ✅ on a ❌ — §5.3), and the audit row's phase-2 outcome is
 * filled in via `updateConsentAuditOutcome` so `drive_consent_audit` shows
 * what actually happened, not just that the human said yes.
 */
export async function buildMutationResult<T extends { error?: string }>(opts: {
  results: T[];
  total: number;
  verb: string;
  summaryIcon: string;
  verify: (item: T) => Promise<VerifyLine>;
  reportTitle: string;
  reportSubtitle: string;
  consentStore?: ConsentStore;
  auditId?: string;
  preSnapshot?: unknown;
}): Promise<ReturnType<typeof ok>> {
  const { results, total, verb, summaryIcon, verify, reportTitle, reportSubtitle, consentStore, auditId, preSnapshot } = opts;
  const succeeded = results.filter((r) => !r.error);
  const pv = await mapWithLimit(succeeded, (r) => verify(r));
  const okN = succeeded.length;
  const failN = total - okN;
  const worst = worstOutcome(pv);
  let icon = summaryIcon;
  let tail = "";
  if (worst === "mismatch") {
    icon = "❌";
    tail = " — РАСХОЖДЕНИЕ при проверке, см. отчёт";
  } else if (worst === "warn" || failN > 0) {
    icon = "⚠️";
    if (failN > 0) tail = ` (${failN} с ошибкой)`;
  }
  if (consentStore && auditId) {
    const errs = results
      .filter((r): r is T & { error: string } => !!r.error)
      .map((r) => r.error)
      .join("; ");
    await consentStore
      .updateConsentAuditOutcome(auditId, {
        outcome: okN > 0 ? "confirmed" : "failed",
        postVerify:
          `${icon} ${verb} ${okN}/${total}${tail}` + (pv.length ? ` · post-verify: ${pv.map((p) => p.line).join("; ")}` : ""),
        error: errs || null,
        ...(preSnapshot !== undefined ? { preSnapshot } : {}),
      })
      .catch((e) => {
        console.error("[consent audit] updateConsentAuditOutcome failed:", e instanceof Error ? e.message : String(e));
      });
  }
  return ok({
    summary: `${icon} ${verb} ${okN}/${total}${tail}`,
    results,
    ...(pv.length ? { verification: renderVerifyReport(reportTitle, reportSubtitle, pv) } : {}),
  });
}

/** Live file metadata (name/mimeType/parents/trashed/md5/modifiedTime/size),
 * or null if unreadable (deleted/no access). Used BOTH to build the plan-time
 * binding snapshot AND to re-read the same file at rehash/post-verify time —
 * the identical function on both sides is what makes the binding a real
 * drift check, not a tautology (gate.md §3.3(2)). */
export async function liveFileMeta(g: GoogleClients, fileId: string): Promise<{
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  trashed: boolean;
  md5Checksum: string | null;
  modifiedTime: string | null;
  size: string | null;
} | null> {
  try {
    const res = await g.drive.files.get({
      fileId,
      fields: "id,name,mimeType,parents,trashed,md5Checksum,modifiedTime,size",
    });
    return {
      id: res.data.id ?? fileId,
      name: res.data.name ?? "",
      mimeType: res.data.mimeType ?? "",
      parents: res.data.parents ?? [],
      trashed: !!res.data.trashed,
      md5Checksum: res.data.md5Checksum ?? null,
      modifiedTime: res.data.modifiedTime ?? null,
      size: res.data.size ?? null,
    };
  } catch {
    return null; // deleted / no access — treated as "gone", not a hard crash
  }
}

/** Live permission list for a file, or null if unreadable. Used both to seed
 * the binding at plan time and to re-read it at rehash/post-verify time for
 * drive_share/drive_unshare — a REAL check of who currently has access, not
 * `sha256(payload)` in disguise. */
export async function livePermissions(g: GoogleClients, fileId: string): Promise<Array<{
  id: string | null;
  type: string | null;
  role: string | null;
  emailAddress: string | null;
  domain: string | null;
}> | null> {
  try {
    const res = await g.drive.permissions.list({
      fileId,
      fields: "permissions(id,type,role,emailAddress,domain)",
    });
    return (res.data.permissions ?? []).map((p) => ({
      id: p.id ?? null,
      type: p.type ?? null,
      role: p.role ?? null,
      emailAddress: p.emailAddress ?? null,
      domain: p.domain ?? null,
    }));
  } catch {
    return null;
  }
}

/** Post-verify: the file still exists and (when a name was requested) still
 * carries it. Used for rename / trash-target existence / generic identity
 * confirmation. */
export async function postVerifyFileIdentity(
  g: GoogleClients,
  fileId: string,
  expectedName: string | null,
  label: string,
): Promise<VerifyLine> {
  const meta = await liveFileMeta(g, fileId);
  const lbl = safeText(label) || "(файл)";
  if (meta === null) {
    return { outcome: "warn", line: `- ⚠️ **«${lbl}»** — не удалось перепроверить файл ${safeText(fileId)}` };
  }
  if (expectedName !== null && meta.name !== expectedName) {
    return { outcome: "mismatch", line: `- ❌ **«${lbl}»** — живое название не совпадает: «${safeText(meta.name)}»` };
  }
  return { outcome: "ok", line: `- ✅ **«${safeText(meta.name) || lbl}»** — подтверждено` };
}

/** Post-verify: file's live `parents` now include `expectedParent` (and, if
 * given, no longer include `removedParent`). */
export async function postVerifyParents(
  g: GoogleClients,
  fileId: string,
  expectedParent: string,
  removedParent: string | undefined,
  label: string,
): Promise<VerifyLine> {
  const meta = await liveFileMeta(g, fileId);
  const lbl = safeText(label) || "(файл)";
  if (meta === null) {
    return { outcome: "warn", line: `- ⚠️ **«${lbl}»** — не удалось перепроверить файл ${safeText(fileId)}` };
  }
  const hasNew = meta.parents.includes(expectedParent);
  const stillHasOld = removedParent ? meta.parents.includes(removedParent) : false;
  if (!hasNew || stillHasOld) {
    return {
      outcome: "mismatch",
      line: `- ❌ **«${safeText(meta.name) || lbl}»** — живые родители не совпадают (${meta.parents.map((p) => safeText(p, 30)).join(", ") || "—"})`,
    };
  }
  return { outcome: "ok", line: `- ✅ **«${safeText(meta.name) || lbl}»** — перемещено, живой родитель подтверждён` };
}

/** Post-verify: file is now trashed (or, honestly, unreadable — Drive can
 * 404 a trashed file for some scopes, reported as ⚠️ not ✅). */
export async function postVerifyTrashed(g: GoogleClients, fileId: string, label: string): Promise<VerifyLine> {
  const meta = await liveFileMeta(g, fileId);
  const lbl = safeText(label) || "(файл)";
  if (meta === null) {
    return { outcome: "warn", line: `- ⚠️ **«${lbl}»** — не удалось перепроверить файл ${safeText(fileId)} после удаления в корзину` };
  }
  if (!meta.trashed) {
    return { outcome: "mismatch", line: `- ❌ **«${safeText(meta.name) || lbl}»** — живой файл НЕ в корзине` };
  }
  return { outcome: "ok", line: `- ✅ **«${safeText(meta.name) || lbl}»** — в корзине, подтверждено` };
}

/** Post-verify: file's live content actually changed (md5Checksum or
 * modifiedTime differs from the pre-mutation snapshot) — the honest signal
 * that an overwrite actually landed, without re-downloading the bytes. */
export async function postVerifyOverwritten(
  g: GoogleClients,
  fileId: string,
  before: { md5Checksum: string | null; modifiedTime: string | null } | null,
  label: string,
): Promise<VerifyLine> {
  const meta = await liveFileMeta(g, fileId);
  const lbl = safeText(label) || "(файл)";
  if (meta === null) {
    return { outcome: "warn", line: `- ⚠️ **«${lbl}»** — не удалось перепроверить файл ${safeText(fileId)}` };
  }
  const changed =
    !before ||
    (before.md5Checksum !== null && meta.md5Checksum !== null && before.md5Checksum !== meta.md5Checksum) ||
    (before.modifiedTime !== null && meta.modifiedTime !== null && before.modifiedTime !== meta.modifiedTime);
  if (!changed) {
    return {
      outcome: "warn",
      line: `- ⚠️ **«${safeText(meta.name) || lbl}»** — содержимое выглядит неизменным (не удалось надёжно подтвердить перезапись по md5/modifiedTime)`,
    };
  }
  return { outcome: "ok", line: `- ✅ **«${safeText(meta.name) || lbl}»** — перезаписано, живые метаданные изменились` };
}

/** Post-verify: a permission matching {type, role, emailAddress?, domain?}
 * now exists in the file's LIVE permission list. */
export async function postVerifyPermissionGranted(
  g: GoogleClients,
  fileId: string,
  expected: { type: string; role: string; emailAddress?: string; domain?: string },
  label: string,
): Promise<VerifyLine> {
  const perms = await livePermissions(g, fileId);
  const lbl = safeText(label) || "(файл)";
  if (perms === null) {
    return { outcome: "warn", line: `- ⚠️ **«${lbl}»** — не удалось перепроверить права доступа файла ${safeText(fileId)}` };
  }
  const found = perms.some(
    (p) =>
      p.type === expected.type &&
      p.role === expected.role &&
      (expected.emailAddress ? p.emailAddress === expected.emailAddress : true) &&
      (expected.domain ? p.domain === expected.domain : true),
  );
  if (!found) {
    return {
      outcome: "mismatch",
      line: `- ❌ **«${lbl}»** — среди живых прав доступа НЕТ ожидаемого (${expected.role} для ${safeText(expected.emailAddress ?? expected.domain ?? expected.type)})`,
    };
  }
  return { outcome: "ok", line: `- ✅ **«${lbl}»** — доступ подтверждён среди живых permissions` };
}

/** Post-verify: `permissionId` is now ABSENT from the file's LIVE permission
 * list (drive_unshare succeeded). */
export async function postVerifyPermissionRemoved(
  g: GoogleClients,
  fileId: string,
  permissionId: string,
  label: string,
): Promise<VerifyLine> {
  const perms = await livePermissions(g, fileId);
  const lbl = safeText(label) || "(файл)";
  if (perms === null) {
    return { outcome: "warn", line: `- ⚠️ **«${lbl}»** — не удалось перепроверить права доступа файла ${safeText(fileId)}` };
  }
  const stillThere = perms.some((p) => p.id === permissionId);
  if (stillThere) {
    return { outcome: "mismatch", line: `- ❌ **«${lbl}»** — право доступа всё ещё в живом списке permissions` };
  }
  return { outcome: "ok", line: `- ✅ **«${lbl}»** — доступ отозван, подтверждено среди живых permissions` };
}

const GOOGLE_DOC_MIME = "application/vnd.google-apps.document";

// ── OCR scratch file: creation, identity guard, and honest cleanup ──────────
//
// Drive's OCR has no "read text" endpoint: the only way in is files.copy with
// mimeType=Google Doc, i.e. a REAL file materialised in the owner's Drive. That
// makes drive_extract_text a write, however read-shaped it looks from outside —
// see the long comment on its registration below for why it stays ungated and
// what has to hold for that to be safe.

/** Name every OCR scratch copy carries — also the identity guard's marker. */
const OCR_TEMP_NAME = "gmcp-ocr-tmp";

/** A temp OCR file that is STILL IN THE USER'S DRIVE after the call. */
export interface OcrCleanupFailure {
  tempFileId: string;
  /** Why it could not be cleaned up — verbatim, never swallowed. */
  error: string;
}

/**
 * Moves the temporary OCR document to the trash, having first checked that the
 * id really points at OUR scratch doc.
 *
 * Two deliberate choices, both reactions to how the old one-liner
 * (`files.delete(...).catch(() => {})`) failed:
 *
 *  - TRASH, not delete. Permanent deletion must never be a side effect of a
 *    text-extraction call: if `docId` were ever wrong (a Drive bug, a future
 *    refactor threading in a caller-supplied id), `files.delete` would destroy
 *    a real user file with no recovery, while trashing is undoable for 30 days.
 *  - IDENTITY GUARD. Before touching anything, re-read the file and require
 *    name+mimeType to match the scratch doc this call just created. A mismatch
 *    means we do NOT touch it and report instead — the same "never act on an
 *    object you did not verify" rule the mutating tools use post-verify for.
 *
 * @returns `null` on success, or a description of the leftover file. The caller
 *   MUST surface a non-null result to the user: a cleanup failure that is only
 *   logged is invisible to the person whose Drive is accumulating the garbage.
 */
export async function cleanupOcrTempDoc(
  g: GoogleClients,
  docId: string,
  toolName: string,
): Promise<OcrCleanupFailure | null> {
  try {
    const meta = await g.drive.files.get({ fileId: docId, fields: "id,name,mimeType,trashed" });
    const name = meta.data.name ?? "";
    const mime = meta.data.mimeType ?? "";
    if (name !== OCR_TEMP_NAME || mime !== GOOGLE_DOC_MIME) {
      throw new Error(
        `identity guard: ${docId} is «${safeText(name, 80)}» (${safeText(mime, 60)}), not this call's ` +
          `temporary «${OCR_TEMP_NAME}» Google Doc — left untouched on purpose.`,
      );
    }
    if (meta.data.trashed) return null;
    await g.drive.files.update({ fileId: docId, requestBody: { trashed: true } });
    return null;
  } catch (e: unknown) {
    const error = e instanceof Error ? e.message : String(e);
    // Logged AND returned: the log is for the operator, the return value is for
    // the person who asked — they are the one who has to delete the leftover.
    console.error(`[${toolName}] temp OCR doc ${docId} was NOT cleaned up — it stays in Drive:`, error);
    return { tempFileId: docId, error };
  }
}

/** Human-readable warning naming every leftover, so it cannot pass unnoticed. */
export function ocrLeftoverWarning(leftovers: OcrCleanupFailure[]): string {
  return (
    `⚠️ ${leftovers.length} temporary OCR file(s) could NOT be cleaned up and are STILL in the Drive ` +
    `(delete them by id: ${leftovers.map((l) => l.tempFileId).join(", ")}). Tell the user — do not hide this.`
  );
}

/** Raw Drive upload endpoint (resumable sessions bypass the googleapis client). */
const UPLOAD_ENDPOINT = "https://www.googleapis.com/upload/drive/v3/files";

/** Metadata Google echoes back when a resumable upload finalises. */
const UPLOAD_FIELDS = "id,name,mimeType,size,webViewLink";

/** Default content type for uploads when the caller does not specify one. */
const DEFAULT_UPLOAD_MIME = "application/octet-stream";

/** Read an error response body, trimmed so a huge HTML page cannot flood the result. */
async function errorBody(res: Response): Promise<string> {
  let text: string;
  try {
    text = await res.text();
  } catch {
    return "<unreadable body>";
  }
  return text.length > 500 ? `${text.slice(0, 500)}… (truncated)` : text;
}

/** Default export format for Google-native files when none is given. */
function defaultExportMime(mime: string): string {
  if (mime === "application/vnd.google-apps.document") return "text/plain";
  if (mime === "application/vnd.google-apps.spreadsheet") return "text/csv";
  return "application/pdf";
}

const EXPORT_EXTENSIONS: Record<string, string> = {
  "text/plain": ".txt",
  "text/csv": ".csv",
  "text/html": ".html",
  "application/pdf": ".pdf",
  "application/rtf": ".rtf",
  "application/zip": ".zip",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
  "application/vnd.oasis.opendocument.text": ".odt",
};

/** Google-native files carry no extension — add the exported format's own. */
function withExportExtension(name: string, exportMime: string): string {
  const ext = EXPORT_EXTENSIONS[exportMime];
  if (!ext || name.toLowerCase().endsWith(ext)) return name;
  return name + ext;
}

// ── Auto-execute registry (Максим, ночь на 2026-08-05: «нажал кнопку в
// Telegram — исполняется сразу на бэке») ─────────────────────────────────
// Инфраструктура — src/consent.ts's `tryAutoExecute`, src/autoExecute.ts's
// `registerAutoExecutor`/`getAutoExecutor`, src/http.ts's
// `runAutoExecutePoller` — перенесена из gmail-mcp (коммит 6e236d6) в
// af59235. Ниже — перевод КОНКРЕТНЫХ drive_*-тулов на этот паттерн, по
// образцу gmail-mcp/src/tools/gmail.ts's `gmail_send`: тело мутации из
// каждого тула вынесено в `executeXxxCore` (модульного уровня, без изменения
// логики), и зарегистрировано в реестре, чтобы фоновый поллер мог исполнить
// его напрямую, в обход модели.

// ── drive_create_folder ──────────────────────────────────────────────────
// Degenerate binding (a not-yet-existing folder has no live object to bind
// against) — same rehash on both the manual (chat) and auto (TG button)
// paths, no `g` needed.

interface CreateFolderItem {
  name: string;
  parentId?: string;
}
export interface CreateFolderPayload {
  account: string;
  folders: CreateFolderItem[];
}

/**
 * Ядро исполнения `drive_create_folder` — вынесено из тела тула (Максим,
 * 2026-08-05), чтобы БЫТЬ ВЫЗЫВАЕМЫМ И ИЗ обычного MCP tool-хендлера (модель
 * вызвала execute второй раз), И ИЗ фонового авто-поллера (кнопка в Telegram
 * сама триггерит это, без участия модели вообще) — см. `autoExecute.ts`'s
 * doc-comment про то, почему это НЕ MCP-параметр, а отдельная функция.
 * Ничего в самой логике не изменилось — просто извлечена в функцию.
 *
 * Максим явно спрашивал про этот сценарий («создалась папка → где в
 * Telegram будет ссылка»): `webViewLink` идёт в `results` внутри
 * `buildMutationResult`, и `humanReadableAutoExecuteReport()` (util.ts)
 * достаёт его оттуда и печатает кликабельным URL-ом рядом с именем объекта —
 * а не как сырой JSON, где раньше ссылка тонула в `\"webViewLink\": \"...\"`.
 */
async function executeCreateFolderCore(
  g: GoogleClients,
  payload: CreateFolderPayload,
  auditId: string,
  consentStore: ConsentStore,
): Promise<CallToolResult> {
  interface CreateFolderResult {
    name: string;
    id: string | null;
    webViewLink: string | null;
    error?: string;
  }
  const results = await mapWithLimit<CreateFolderItem, CreateFolderResult>(payload.folders, async ({ name, parentId }) => {
    try {
      const res = await g.drive.files.create({
        requestBody: {
          name,
          mimeType: "application/vnd.google-apps.folder",
          parents: parentId ? [parentId] : undefined,
        },
        fields: "id,name,webViewLink",
      });
      return { name: res.data.name ?? name, id: res.data.id ?? null, webViewLink: res.data.webViewLink ?? null };
    } catch (e: unknown) {
      return { name, id: null, webViewLink: null, error: e instanceof Error ? e.message : String(e) };
    }
  });
  return buildMutationResult({
    results,
    total: payload.folders.length,
    verb: "Создано",
    summaryIcon: "📁",
    verify: (r) => postVerifyFileIdentity(g, r.id ?? "", r.name, r.name),
    reportTitle: "Независимая проверка создания папок",
    reportSubtitle: "запрошено ⇄ живые файлы Drive",
    consentStore,
    auditId,
  });
}

registerAutoExecutor("drive_create_folder", {
  rehash: (addressing) => sha256(addressing as CreateFolderPayload),
  execute: async (payload, auditId, ctx: AutoExecutorCtx) => {
    const p = payload as CreateFolderPayload;
    const g = ctx.clients.resolve(p.account);
    const result = await executeCreateFolderCore(g, p, auditId, ctx.consentStore);
    return humanReadableAutoExecuteReport(result);
  },
});

// ── drive_rename ──────────────────────────────────────────────────────────
// REAL binding: re-reads each file's LIVE current name — same rehash logic
// (`renameRehash`) used on both the manual (chat) path and the auto (TG
// button) path, just wired to `g` differently (already-resolved closure vs
// `ctx.clients.resolve(...)`).

export interface RenameItem {
  fileId: string;
  newName: string;
}
export interface RenamePayload {
  account: string;
  items: RenameItem[];
}

async function renameBindingSnapshot(g: GoogleClients, items: RenameItem[]) {
  return mapWithLimit(items, async (it) => ({
    fileId: it.fileId,
    newName: it.newName,
    currentName: (await liveFileMeta(g, it.fileId))?.name ?? null,
  }));
}

async function renameRehash(g: GoogleClients, addressing: ConsentAddressing): Promise<string> {
  const a = addressing as RenamePayload;
  const snapshot = await renameBindingSnapshot(g, a.items);
  return sha256({ account: a.account, items: snapshot });
}

async function executeRenameCore(
  g: GoogleClients,
  payload: RenamePayload,
  auditId: string,
  consentStore: ConsentStore,
): Promise<CallToolResult> {
  const preSnapshot = await renameBindingSnapshot(g, payload.items);
  interface RenameResult {
    fileId: string;
    oldName: string | null;
    newName: string;
    error?: string;
  }
  const results = await mapWithLimit<RenameItem, RenameResult>(payload.items, async ({ fileId, newName }) => {
    const oldName = preSnapshot.find((s) => s.fileId === fileId)?.currentName ?? null;
    try {
      await g.drive.files.update({ fileId, requestBody: { name: newName }, fields: "id,name" });
      return { fileId, oldName, newName };
    } catch (e: unknown) {
      return { fileId, oldName, newName, error: e instanceof Error ? e.message : String(e) };
    }
  });
  return buildMutationResult({
    results,
    total: payload.items.length,
    verb: "Переименовано",
    summaryIcon: "✏️",
    verify: (r) =>
      postVerifyFileIdentity(g, r.fileId, r.newName, r.oldName ? `${r.oldName} → ${r.newName}` : r.newName),
    reportTitle: "Независимая проверка переименования",
    reportSubtitle: "запрошено ⇄ живые файлы Drive",
    consentStore,
    auditId,
  });
}

registerAutoExecutor("drive_rename", {
  rehash: (addressing, ctx: AutoExecutorCtx) => {
    const p = addressing as RenamePayload;
    const g = ctx.clients.resolve(p.account);
    return renameRehash(g, addressing);
  },
  execute: async (payload, auditId, ctx: AutoExecutorCtx) => {
    const p = payload as RenamePayload;
    const g = ctx.clients.resolve(p.account);
    const result = await executeRenameCore(g, p, auditId, ctx.consentStore);
    return humanReadableAutoExecuteReport(result);
  },
});

// ── drive_move ────────────────────────────────────────────────────────────
// REAL binding: re-reads each file's LIVE `parents` — same shared rehash
// (`moveRehash`) on both paths.

export interface MoveItem {
  fileId: string;
  newParentId: string;
  removeParentId?: string;
}
export interface MovePayload {
  account: string;
  items: MoveItem[];
}

async function moveBindingSnapshot(g: GoogleClients, items: MoveItem[]) {
  return mapWithLimit(items, async (it) => ({
    fileId: it.fileId,
    newParentId: it.newParentId,
    removeParentId: it.removeParentId ?? null,
    currentParents: (await liveFileMeta(g, it.fileId))?.parents ?? [],
  }));
}

async function moveRehash(g: GoogleClients, addressing: ConsentAddressing): Promise<string> {
  const a = addressing as MovePayload;
  const snapshot = await moveBindingSnapshot(g, a.items);
  return sha256({ account: a.account, items: snapshot });
}

async function executeMoveCore(
  g: GoogleClients,
  payload: MovePayload,
  auditId: string,
  consentStore: ConsentStore,
): Promise<CallToolResult> {
  interface MoveResult {
    fileId: string;
    name: string | null;
    newParentId: string;
    newParentName: string | null;
    removedParentId: string | null;
    removedParentName: string | null;
    parents: string[] | null;
    error?: string;
  }
  // Folder names are looked up once per distinct id, not once per item —
  // several items commonly share the same source/destination folder.
  const folderNameCache = new Map<string, Promise<string | null>>();
  const folderName = (id: string | undefined | null): Promise<string | null> => {
    if (!id) return Promise.resolve(null);
    let p = folderNameCache.get(id);
    if (!p) {
      p = liveFileMeta(g, id).then((m) => m?.name ?? null);
      folderNameCache.set(id, p);
    }
    return p;
  };
  const results = await mapWithLimit<MoveItem, MoveResult>(payload.items, async ({ fileId, newParentId, removeParentId }) => {
    const [newParentName, removedParentName] = await Promise.all([
      folderName(newParentId),
      folderName(removeParentId),
    ]);
    try {
      const res = await g.drive.files.update({
        fileId,
        addParents: newParentId,
        removeParents: removeParentId,
        fields: "id,name,parents",
      });
      return {
        fileId,
        name: res.data.name ?? null,
        newParentId,
        newParentName,
        removedParentId: removeParentId ?? null,
        removedParentName,
        parents: res.data.parents ?? null,
      };
    } catch (e: unknown) {
      return {
        fileId,
        name: null,
        newParentId,
        newParentName,
        removedParentId: removeParentId ?? null,
        removedParentName,
        parents: null,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  });
  return buildMutationResult({
    results,
    total: payload.items.length,
    verb: "Перемещено",
    summaryIcon: "📂",
    verify: (r) => {
      const item = payload.items.find((it) => it.fileId === r.fileId);
      const label = r.name
        ? `${r.name} → ${r.newParentName ?? r.newParentId}`
        : r.fileId;
      return postVerifyParents(g, r.fileId, r.newParentId, item?.removeParentId, label);
    },
    reportTitle: "Независимая проверка перемещения",
    reportSubtitle: "запрошено ⇄ живые родители Drive",
    consentStore,
    auditId,
  });
}

registerAutoExecutor("drive_move", {
  rehash: (addressing, ctx: AutoExecutorCtx) => {
    const p = addressing as MovePayload;
    const g = ctx.clients.resolve(p.account);
    return moveRehash(g, addressing);
  },
  execute: async (payload, auditId, ctx: AutoExecutorCtx) => {
    const p = payload as MovePayload;
    const g = ctx.clients.resolve(p.account);
    const result = await executeMoveCore(g, p, auditId, ctx.consentStore);
    return humanReadableAutoExecuteReport(result);
  },
});

// ── drive_trash ───────────────────────────────────────────────────────────
// REAL binding: re-reads each file's LIVE {name, parents, trashed}. Also
// captures a pre-mutation snapshot (identity-postverify.md §5.2) — same in
// both executeTrashCore call sites, since it lives inside the core function.

export interface TrashPayload {
  account: string;
  fileIds: string[];
}

async function trashBindingSnapshot(g: GoogleClients, fileIds: string[]) {
  return mapWithLimit(fileIds, async (fileId) => {
    const meta = await liveFileMeta(g, fileId);
    return {
      fileId,
      name: meta?.name ?? null,
      parents: meta?.parents ?? [],
      trashed: meta?.trashed ?? null,
    };
  });
}

async function trashRehash(g: GoogleClients, addressing: ConsentAddressing): Promise<string> {
  const a = addressing as TrashPayload;
  const snapshot = await trashBindingSnapshot(g, a.fileIds);
  return sha256({ account: a.account, fileIds: a.fileIds, snapshot });
}

async function executeTrashCore(
  g: GoogleClients,
  payload: TrashPayload,
  auditId: string,
  consentStore: ConsentStore,
): Promise<CallToolResult> {
  const preSnapshot = await trashBindingSnapshot(g, payload.fileIds);
  interface TrashResult {
    fileId: string;
    name: string | null;
    trashed: boolean;
    error?: string;
  }
  const results = await mapWithLimit<string, TrashResult>(payload.fileIds, async (fileId) => {
    const preName = preSnapshot.find((s) => s.fileId === fileId)?.name ?? null;
    try {
      const res = await g.drive.files.update({ fileId, requestBody: { trashed: true }, fields: "id,name,trashed" });
      return { fileId, name: res.data.name ?? preName, trashed: true as const };
    } catch (e: unknown) {
      return { fileId, name: preName, trashed: false, error: e instanceof Error ? e.message : String(e) };
    }
  });
  return buildMutationResult({
    results,
    total: payload.fileIds.length,
    verb: "Удалено в Корзину",
    summaryIcon: "🗑",
    verify: (r) => {
      const label = r.name ?? preSnapshot.find((s) => s.fileId === r.fileId)?.name ?? r.fileId;
      return postVerifyTrashed(g, r.fileId, label);
    },
    reportTitle: "Независимая проверка удаления в Корзину",
    reportSubtitle: "запрошено ⇄ живые файлы Drive",
    consentStore,
    auditId,
    preSnapshot,
  });
}

registerAutoExecutor("drive_trash", {
  rehash: (addressing, ctx: AutoExecutorCtx) => {
    const p = addressing as TrashPayload;
    const g = ctx.clients.resolve(p.account);
    return trashRehash(g, addressing);
  },
  execute: async (payload, auditId, ctx: AutoExecutorCtx) => {
    const p = payload as TrashPayload;
    const g = ctx.clients.resolve(p.account);
    const result = await executeTrashCore(g, p, auditId, ctx.consentStore);
    return humanReadableAutoExecuteReport(result);
  },
});

// ── drive_upload_file ────────────────────────────────────────────────────
// Degenerate binding, same as drive_create_folder — brand-new files have no
// live object to bind against yet.

export interface UploadFileItem {
  name: string;
  mimeType?: string;
  parentId?: string;
  content_text?: string;
  content_base64?: string;
}
export interface UploadFilePayload {
  account: string;
  files: UploadFileItem[];
}

async function executeUploadFileCore(
  g: GoogleClients,
  payload: UploadFilePayload,
  auditId: string,
  consentStore: ConsentStore,
): Promise<CallToolResult> {
  interface UploadFileResult {
    name: string;
    id: string | null;
    webViewLink: string | null;
    error?: string;
  }
  const results = await mapWithLimit<UploadFileItem, UploadFileResult>(
    payload.files,
    async ({ name, mimeType, parentId, content_text, content_base64 }) => {
      try {
        if (!content_text && !content_base64) {
          return { name, id: null, webViewLink: null, error: "Provide either content_text or content_base64." };
        }
        const buffer = content_base64
          ? Buffer.from(content_base64, "base64")
          : Buffer.from(content_text ?? "", "utf8");
        const mediaMimeType = mimeType ?? "application/octet-stream";
        const res = await g.drive.files.create({
          requestBody: { name, parents: parentId ? [parentId] : undefined },
          media: { mimeType: mediaMimeType, body: Readable.from(buffer) },
          fields: "id,name,webViewLink",
        });
        return { name: res.data.name ?? name, id: res.data.id ?? null, webViewLink: res.data.webViewLink ?? null };
      } catch (e: unknown) {
        return { name, id: null, webViewLink: null, error: e instanceof Error ? e.message : String(e) };
      }
    },
  );
  return buildMutationResult({
    results,
    total: payload.files.length,
    verb: "Загружено",
    summaryIcon: "⬆️",
    verify: (r) => postVerifyFileIdentity(g, r.id ?? "", r.name, r.name),
    reportTitle: "Независимая проверка загрузки",
    reportSubtitle: "запрошено ⇄ живые файлы Drive",
    consentStore,
    auditId,
  });
}

registerAutoExecutor("drive_upload_file", {
  rehash: (addressing) => sha256(addressing as UploadFilePayload),
  execute: async (payload, auditId, ctx: AutoExecutorCtx) => {
    const p = payload as UploadFilePayload;
    const g = ctx.clients.resolve(p.account);
    const result = await executeUploadFileCore(g, p, auditId, ctx.consentStore);
    return humanReadableAutoExecuteReport(result);
  },
});

// ── drive_create_upload_session ──────────────────────────────────────────
// For a REPLACE (`fileId` given) this is a REAL rehash of the live target
// file; for a brand-new file it's the same degenerate case as
// drive_create_folder/drive_upload_file — `uploadSessionBindingSnapshot`
// handles both uniformly.

export interface UploadSessionItem {
  name?: string;
  mimeType?: string;
  sizeBytes?: number;
  parentId?: string;
  fileId?: string;
}
export interface UploadSessionPayload {
  account: string;
  files: UploadSessionItem[];
}

async function uploadSessionBindingSnapshot(g: GoogleClients, files: UploadSessionItem[]) {
  return mapWithLimit(files, async (f) => {
    if (!f.fileId) return { ...f, liveTarget: null };
    const meta = await liveFileMeta(g, f.fileId);
    return {
      ...f,
      liveTarget: meta ? { name: meta.name, mimeType: meta.mimeType, md5Checksum: meta.md5Checksum } : null,
    };
  });
}

async function uploadSessionRehash(g: GoogleClients, addressing: ConsentAddressing): Promise<string> {
  const a = addressing as UploadSessionPayload;
  const snapshot = await uploadSessionBindingSnapshot(g, a.files);
  return sha256({ account: a.account, files: snapshot });
}

async function executeUploadSessionCore(
  g: GoogleClients,
  payload: UploadSessionPayload,
  auditId: string,
  consentStore: ConsentStore,
): Promise<CallToolResult> {
  const token = await g.accessToken();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  interface UploadSessionResult {
    name: string | null;
    fileId: string | null;
    mode?: "create" | "replace";
    /** Непрозрачный идентификатор сессии — ИМЕННО ЕГО ждёт обратно
     * `drive_confirm_upload`. Сам адрес обратно не принимается (SSRF). */
    sessionId?: string;
    uploadUrl?: string;
    mimeType?: string;
    sizeBytes?: number | null;
    expiresAt?: string;
    howTo?: string;
    error?: string;
  }
  const results = await mapWithLimit<UploadSessionItem, UploadSessionResult>(payload.files, async ({ name, mimeType, sizeBytes, parentId, fileId }) => {
    const label = name ?? fileId ?? null;
    try {
      if (!name && !fileId) {
        return { name: label, fileId: fileId ?? null, error: "Provide `name` (new file) or `fileId` (replace)." };
      }
      if (fileId && parentId) {
        return {
          name: label,
          fileId: fileId ?? null,
          error: "parentId cannot be combined with fileId — use drive_move to reparent.",
        };
      }
      const resolvedMime = mimeType ?? DEFAULT_UPLOAD_MIME;
      const url =
        `${UPLOAD_ENDPOINT}${fileId ? `/${encodeURIComponent(fileId)}` : ""}` +
        `?uploadType=resumable&supportsAllDrives=true` +
        `&fields=${encodeURIComponent(UPLOAD_FIELDS)}`;
      const metadata: Record<string, unknown> = {};
      if (name) metadata.name = name;
      if (!fileId && parentId) metadata.parents = [parentId];

      // safeGoogleFetch, а не голый fetch: здесь уходит Bearer-токен аккаунта,
      // и молча последовать за перенаправлением на чужой хост означало бы
      // отдать этот токен туда. Сам адрес собран из константы UPLOAD_ENDPOINT,
      // но проверка всё равно единая для всех исходящих запросов к Google.
      const res = await safeGoogleFetch(url, {
        method: fileId ? "PATCH" : "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json; charset=UTF-8",
          "X-Upload-Content-Type": resolvedMime,
          ...(sizeBytes ? { "X-Upload-Content-Length": String(sizeBytes) } : {}),
        },
        body: JSON.stringify(metadata),
      });
      if (!res.ok) {
        return { name: label, fileId: fileId ?? null, error: `Google returned ${res.status}: ${await errorBody(res)}` };
      }
      const uploadUrl = res.headers.get("location");
      if (!uploadUrl) {
        return {
          name: label,
          fileId: fileId ?? null,
          error: "Google did not return a resumable session URI (no Location header).",
        };
      }
      // Даже адрес, пришедший от самого Google, проверяем: дальше по нему
      // будет ходить сервер (drive_confirm_upload), и хранить непроверенный
      // адрес — значит отложить проблему, а не решить её.
      try {
        assertAllowedGoogleUrl(uploadUrl);
      } catch (e) {
        return {
          name: label,
          fileId: fileId ?? null,
          error: `Google вернул недопустимый адрес сессии загрузки (${e instanceof Error ? e.message : String(e)}).`,
        };
      }
      const remembered = await rememberUploadSession({
        account: payload.account,
        uploadUrl,
        mode: fileId ? "replace" : "create",
        fileId: fileId ?? null,
        name: name ?? null,
        mimeType: resolvedMime,
        sizeBytes: sizeBytes ?? null,
      });
      const total = sizeBytes ? String(sizeBytes) : "*";
      const lastByte = sizeBytes ? String(sizeBytes - 1) : "<end>";
      const howTo =
        `PUT the raw bytes to uploadUrl with headers "Content-Type: ${resolvedMime}" and ` +
        `"Content-Range: bytes 0-${lastByte}/${total}"` +
        (sizeBytes
          ? " (a single PUT of the whole file is fine). "
          : " — the total size is unknown, so keep sending '*' as the total and put the " +
            "real total in the Content-Range of the FINAL chunk to finalise the upload. ") +
        "Then call drive_confirm_upload with the `sessionId` below (NOT the uploadUrl — the " +
        "server keeps the address itself and does not accept one from a tool argument).";
      return {
        name: name ?? null,
        fileId: fileId ?? null,
        mode: fileId ? ("replace" as const) : ("create" as const),
        sessionId: remembered.sessionId,
        uploadUrl,
        mimeType: resolvedMime,
        sizeBytes: sizeBytes ?? null,
        expiresAt,
        howTo,
      };
    } catch (e: unknown) {
      return { name: label, fileId: fileId ?? null, error: e instanceof Error ? e.message : String(e) };
    }
  });
  // Honest limit (STANDARD §15.1 Q20, same convention as sheets-mcp's
  // raw_batch_update): the actual bytes travel via a LATER, out-of-band
  // client→Google PUT this server never sees, so nothing here can confirm
  // content landed — that is what drive_confirm_upload is for. This only
  // confirms the session-creation call itself succeeded.
  return buildMutationResult({
    results,
    total: payload.files.length,
    verb: "Создано сессий загрузки",
    summaryIcon: "⬆️",
    verify: async (r) =>
      r.uploadUrl
        ? {
            outcome: "warn",
            line: `- ⚠️ **«${safeText(r.name ?? r.fileId ?? "", 60)}»** — сессия создана; фактическая загрузка байт идёт напрямую клиент→Google и не проверяется этим вызовом, используйте drive_confirm_upload`,
          }
        : { outcome: "warn", line: `- ⚠️ **«${safeText(r.name ?? r.fileId ?? "", 60)}»** — сессия не создана` },
    reportTitle: "Независимая проверка создания сессии загрузки",
    reportSubtitle: "честный предел: содержимое проверяется отдельно через drive_confirm_upload",
    consentStore,
    auditId,
  });
}

registerAutoExecutor("drive_create_upload_session", {
  rehash: (addressing, ctx: AutoExecutorCtx) => {
    const p = addressing as UploadSessionPayload;
    const g = ctx.clients.resolve(p.account);
    return uploadSessionRehash(g, addressing);
  },
  execute: async (payload, auditId, ctx: AutoExecutorCtx) => {
    const p = payload as UploadSessionPayload;
    const g = ctx.clients.resolve(p.account);
    const result = await executeUploadSessionCore(g, p, auditId, ctx.consentStore);
    return humanReadableAutoExecuteReport(result);
  },
});

// ── drive_overwrite_file ─────────────────────────────────────────────────
// REAL binding: re-reads each target's LIVE {name, mimeType, md5Checksum,
// modifiedTime}. Also captures a pre-mutation snapshot (identity-postverify
// §5.2) inside the core function, so both call sites get it identically.

export interface OverwriteItem {
  fileId: string;
  mimeType?: string;
  content_text?: string;
  content_base64?: string;
}
export interface OverwritePayload {
  account: string;
  files: OverwriteItem[];
}

async function overwriteBindingSnapshot(g: GoogleClients, files: OverwriteItem[]) {
  return mapWithLimit(files, async (f) => {
    const meta = await liveFileMeta(g, f.fileId);
    return {
      fileId: f.fileId,
      mimeType: f.mimeType,
      name: meta?.name ?? null,
      liveMimeType: meta?.mimeType ?? null,
      md5Checksum: meta?.md5Checksum ?? null,
      modifiedTime: meta?.modifiedTime ?? null,
      size: meta?.size ?? null,
    };
  });
}

async function overwriteRehash(g: GoogleClients, addressing: ConsentAddressing): Promise<string> {
  const a = addressing as OverwritePayload;
  const snapshot = await overwriteBindingSnapshot(g, a.files);
  return sha256({ account: a.account, files: snapshot });
}

async function executeOverwriteCore(
  g: GoogleClients,
  payload: OverwritePayload,
  auditId: string,
  consentStore: ConsentStore,
): Promise<CallToolResult> {
  const preSnapshot = await overwriteBindingSnapshot(g, payload.files);
  interface OverwriteResult {
    fileId: string;
    name: string | null;
    error?: string;
  }
  const results = await mapWithLimit<OverwriteItem, OverwriteResult>(payload.files, async ({ fileId, mimeType, content_text, content_base64 }) => {
    try {
      if (!content_text && !content_base64) {
        return { fileId, name: null, error: "Provide either content_text or content_base64." };
      }
      const buffer = content_base64
        ? Buffer.from(content_base64, "base64")
        : Buffer.from(content_text ?? "", "utf8");
      const mediaMimeType = mimeType ?? "application/octet-stream";
      const res = await g.drive.files.update({
        fileId,
        requestBody: {},
        media: { mimeType: mediaMimeType, body: Readable.from(buffer) },
        fields: "id,name",
      });
      return { fileId, name: res.data.name ?? null };
    } catch (e: unknown) {
      return { fileId, name: null, error: e instanceof Error ? e.message : String(e) };
    }
  });
  return buildMutationResult({
    results,
    total: payload.files.length,
    verb: "Перезаписано",
    summaryIcon: "♻️",
    verify: (r) => {
      const before = preSnapshot.find((s) => s.fileId === r.fileId) ?? null;
      return postVerifyOverwritten(g, r.fileId, before, r.name ?? r.fileId);
    },
    reportTitle: "Независимая проверка перезаписи",
    reportSubtitle: "запрошено ⇄ живые метаданные Drive",
    consentStore,
    auditId,
    preSnapshot,
  });
}

registerAutoExecutor("drive_overwrite_file", {
  rehash: (addressing, ctx: AutoExecutorCtx) => {
    const p = addressing as OverwritePayload;
    const g = ctx.clients.resolve(p.account);
    return overwriteRehash(g, addressing);
  },
  execute: async (payload, auditId, ctx: AutoExecutorCtx) => {
    const p = payload as OverwritePayload;
    const g = ctx.clients.resolve(p.account);
    const result = await executeOverwriteCore(g, p, auditId, ctx.consentStore);
    return humanReadableAutoExecuteReport(result);
  },
});

// ── drive_share / drive_unshare ──────────────────────────────────────────
// Both REAL-bind against the same live {name, permissions} snapshot
// (`shareBindingSnapshot`), shared here since it's identical for granting
// and revoking access — only the rehash payload shape differs.

export interface ShareItem {
  fileId: string;
  role: "reader" | "commenter" | "writer" | "fileOrganizer" | "organizer" | "owner";
  type: "user" | "group" | "domain" | "anyone";
  emailAddress?: string;
  domain?: string;
  sendNotificationEmail?: boolean;
  emailMessage?: string;
  transferOwnership?: boolean;
}
export interface SharePayload {
  account: string;
  items: ShareItem[];
}

export interface UnshareItem {
  fileId: string;
  permissionId: string;
}
export interface UnsharePayload {
  account: string;
  items: UnshareItem[];
}

async function shareBindingSnapshot(g: GoogleClients, items: Array<{ fileId: string }>) {
  return mapWithLimit(items, async (it) => {
    const [meta, perms] = await Promise.all([liveFileMeta(g, it.fileId), livePermissions(g, it.fileId)]);
    return {
      fileId: it.fileId,
      name: meta?.name ?? null,
      permissions: perms ?? [],
    };
  });
}

async function shareRehash(g: GoogleClients, addressing: ConsentAddressing): Promise<string> {
  const a = addressing as SharePayload;
  const snapshot = await shareBindingSnapshot(g, a.items);
  return sha256({ account: a.account, items: a.items, snapshot });
}

async function unshareRehash(g: GoogleClients, addressing: ConsentAddressing): Promise<string> {
  const a = addressing as UnsharePayload;
  const snapshot = await shareBindingSnapshot(g, a.items);
  return sha256({ account: a.account, items: a.items, snapshot });
}

async function executeShareCore(
  g: GoogleClients,
  payload: SharePayload,
  auditId: string,
  consentStore: ConsentStore,
): Promise<CallToolResult> {
  const preSnapshot = await shareBindingSnapshot(g, payload.items);
  interface ShareResult {
    fileId: string;
    name: string | null;
    role: string;
    type: string;
    emailAddress: string | null;
    domain: string | null;
    permissionId: string | null;
    error?: string;
  }
  const results = await mapWithLimit<ShareItem, ShareResult>(
    payload.items,
    async ({ fileId, role, type, emailAddress, domain, sendNotificationEmail, emailMessage, transferOwnership }) => {
      const name = preSnapshot.find((s) => s.fileId === fileId)?.name ?? null;
      try {
        const res = await g.drive.permissions.create({
          fileId,
          sendNotificationEmail: sendNotificationEmail ?? false,
          emailMessage,
          transferOwnership: transferOwnership ?? false,
          requestBody: { role, type, emailAddress, domain },
          fields: "id,role,type,emailAddress",
        });
        return {
          fileId,
          name,
          role,
          type,
          emailAddress: emailAddress ?? null,
          domain: domain ?? null,
          permissionId: res.data.id ?? null,
        };
      } catch (e: unknown) {
        return {
          fileId,
          name,
          role,
          type,
          emailAddress: emailAddress ?? null,
          domain: domain ?? null,
          permissionId: null,
          error: e instanceof Error ? e.message : String(e),
        };
      }
    },
  );
  return buildMutationResult({
    results,
    total: payload.items.length,
    verb: "Открыт доступ",
    summaryIcon: "✅",
    verify: (r) =>
      postVerifyPermissionGranted(
        g,
        r.fileId,
        { type: r.type, role: r.role, emailAddress: r.emailAddress ?? undefined, domain: r.domain ?? undefined },
        r.name ?? r.fileId,
      ),
    reportTitle: "Независимая проверка открытия доступа",
    reportSubtitle: "запрошено ⇄ живые permissions Drive",
    consentStore,
    auditId,
  });
}

async function executeUnshareCore(
  g: GoogleClients,
  payload: UnsharePayload,
  auditId: string,
  consentStore: ConsentStore,
): Promise<CallToolResult> {
  const preSnapshot = await shareBindingSnapshot(g, payload.items);
  interface UnshareResult {
    fileId: string;
    name: string | null;
    permissionId: string;
    error?: string;
  }
  const results = await mapWithLimit<UnshareItem, UnshareResult>(payload.items, async ({ fileId, permissionId }) => {
    const name = preSnapshot.find((s) => s.fileId === fileId)?.name ?? null;
    try {
      await g.drive.permissions.delete({ fileId, permissionId });
      return { fileId, name, permissionId };
    } catch (e: unknown) {
      return { fileId, name, permissionId, error: e instanceof Error ? e.message : String(e) };
    }
  });
  return buildMutationResult({
    results,
    total: payload.items.length,
    verb: "Отозван доступ",
    summaryIcon: "🔒",
    verify: (r) => postVerifyPermissionRemoved(g, r.fileId, r.permissionId, r.name ?? r.fileId),
    reportTitle: "Независимая проверка отзыва доступа",
    reportSubtitle: "запрошено ⇄ живые permissions Drive",
    consentStore,
    auditId,
  });
}

registerAutoExecutor("drive_share", {
  rehash: (addressing, ctx: AutoExecutorCtx) => {
    const p = addressing as SharePayload;
    const g = ctx.clients.resolve(p.account);
    return shareRehash(g, addressing);
  },
  execute: async (payload, auditId, ctx: AutoExecutorCtx) => {
    const p = payload as SharePayload;
    const g = ctx.clients.resolve(p.account);
    const result = await executeShareCore(g, p, auditId, ctx.consentStore);
    return humanReadableAutoExecuteReport(result);
  },
});

registerAutoExecutor("drive_unshare", {
  rehash: (addressing, ctx: AutoExecutorCtx) => {
    const p = addressing as UnsharePayload;
    const g = ctx.clients.resolve(p.account);
    return unshareRehash(g, addressing);
  },
  execute: async (payload, auditId, ctx: AutoExecutorCtx) => {
    const p = payload as UnsharePayload;
    const g = ctx.clients.resolve(p.account);
    const result = await executeUnshareCore(g, p, auditId, ctx.consentStore);
    return humanReadableAutoExecuteReport(result);
  },
});

// ── drive_get_download_url ───────────────────────────────────────────────
// ГЕЙТОВАН (задача #112). Раньше был помечен `readOnlyHint` и вызывался
// моделью без единой кнопки. «Только чтение» здесь — иллюзия: инструмент не
// читает файл, он РАЗДАЁТ К НЕМУ ДОСТУП. Выданная ссылка сама является
// доступом: кто её получил — скачает файл без всякой авторизации, живёт она
// около суток и НЕ ОТЗЫВАЕТСЯ. Утечка такой ссылки в лог, в чат или в чужой
// контекст равна утечке самого файла — то есть по последствиям это выдача
// прав, как `drive_share`, а не чтение.
//
// Binding РЕАЛЬНЫЙ: перечитывает живые метаданные каждого файла (имя, тип,
// размер, корзина) — если между планом и подтверждением файл подменили или
// удалили, дрейф ловится и ссылка не выдаётся.

export interface DownloadUrlItem {
  fileId: string;
  exportMimeType?: string;
}
export interface DownloadUrlPayload {
  account: string;
  ttlMinutes: number;
  files: DownloadUrlItem[];
}

async function downloadUrlBindingSnapshot(g: GoogleClients, files: DownloadUrlItem[]) {
  return mapWithLimit(files, async (f) => {
    const meta = await liveFileMeta(g, f.fileId);
    return {
      fileId: f.fileId,
      exportMimeType: f.exportMimeType ?? null,
      name: meta?.name ?? null,
      mimeType: meta?.mimeType ?? null,
      size: meta?.size ?? null,
      trashed: meta?.trashed ?? null,
      md5Checksum: meta?.md5Checksum ?? null,
    };
  });
}

async function downloadUrlRehash(g: GoogleClients, addressing: ConsentAddressing): Promise<string> {
  const a = addressing as DownloadUrlPayload;
  const snapshot = await downloadUrlBindingSnapshot(g, a.files);
  return sha256({ account: a.account, ttlMinutes: a.ttlMinutes, files: snapshot });
}

/** Человеческая формулировка того, ЧТО именно подтверждает владелец. Вынесена
 * отдельной константой, потому что это и есть текст, который человек читает
 * над кнопкой «✅ Подтвердить» в Telegram: невнятный текст обесценивает всю
 * кнопку — подтверждают то, что поняли. */
export function downloadUrlConsentWarning(ttlMinutes: number, expiresAtMs: number): string {
  return (
    "⚠️ **Ссылка — это и есть доступ к файлу.** Любой, у кого она окажется (переслали, попала в " +
    "лог, в чужой контекст), скачает файл БЕЗ входа в Google-аккаунт и без каких-либо прав. " +
    `**Отозвать выданную ссылку нельзя** — она работает, пока не истечёт срок: ${ttlMinutes} мин ` +
    `(примерно до ${formatLaTime(expiresAtMs)} PT).`
  );
}

/** Хвост превью: буквально расшифровывает, что делает кнопка подтверждения. */
export function downloadUrlConsentButtonLine(count: number, ttlMinutes: number): string {
  return (
    `_Кнопка «✅ Подтвердить» означает: ВЫДАТЬ ${count === 1 ? "ссылку" : `${count} ссылки`}, по ` +
    `${count === 1 ? "которой" : "которым"} файл скачает любой, у кого она есть; отозвать нельзя; ` +
    `живёт ~${ttlMinutes} мин._`
  );
}

async function executeGetDownloadUrlCore(
  g: GoogleClients,
  payload: DownloadUrlPayload,
  auditId: string,
  consentStore: ConsentStore,
): Promise<CallToolResult> {
  interface LinkResult {
    fileId: string;
    name?: string;
    mimeType?: string;
    size?: string | null;
    downloadUrl?: string;
    expiresAt?: string;
    error?: string;
  }
  const results = await mapWithLimit<DownloadUrlItem, LinkResult>(payload.files, async ({ fileId, exportMimeType }) => {
    try {
      const meta = await g.drive.files.get({
        fileId,
        fields: "id,name,mimeType,size",
        supportsAllDrives: true,
      });
      const mime = meta.data.mimeType ?? "application/octet-stream";
      const isNative = mime.startsWith("application/vnd.google-apps.");
      const exportMime = isNative ? exportMimeType ?? defaultExportMime(mime) : undefined;
      const name = exportMime
        ? withExportExtension(meta.data.name ?? "file", exportMime)
        : meta.data.name ?? "file";
      const { url, expiresAt } = await issueDownloadLink(
        {
          account: payload.account,
          fileId,
          exportMime,
          name,
          mimeType: exportMime ?? mime,
          size: meta.data.size ? Number(meta.data.size) : undefined,
        },
        payload.ttlMinutes,
      );
      return {
        fileId,
        name,
        mimeType: exportMime ?? mime,
        // Exports are generated on the fly, so their size is unknown up front.
        size: exportMime ? null : meta.data.size ?? null,
        downloadUrl: url,
        expiresAt,
      };
    } catch (e: unknown) {
      return { fileId, error: e instanceof Error ? e.message : String(e) };
    }
  });
  return buildMutationResult({
    results,
    total: payload.files.length,
    verb: "Выдано ссылок:",
    summaryIcon: "🔗",
    // Post-verify не «доверяем своему же ответу»: перечитываем выданный токен
    // из хранилища ссылок и проверяем, что он ведёт ИМЕННО к этому файлу.
    verify: (r) => postVerifyDownloadLink(r.downloadUrl ?? null, r.fileId, r.name ?? r.fileId),
    reportTitle: "Независимая проверка выданных ссылок",
    reportSubtitle: "выданная ссылка ⇄ запись в хранилище ссылок сервера",
    consentStore,
    auditId,
  });
}

/** Post-verify для выданной ссылки: токен реально сохранён и указывает на
 * тот же файл (а не «сервер сказал, что выдал»). */
export async function postVerifyDownloadLink(
  downloadUrl: string | null,
  fileId: string,
  label: string,
): Promise<VerifyLine> {
  const lbl = safeText(label) || "(файл)";
  if (!downloadUrl) {
    return { outcome: "warn", line: `- ⚠️ **«${lbl}»** — ссылка не выдана` };
  }
  const token = downloadUrl.split("/dl/")[1] ?? "";
  const target = await resolveDownloadLink(token);
  if (!target) {
    return { outcome: "mismatch", line: `- ❌ **«${lbl}»** — выданной ссылки нет в хранилище сервера` };
  }
  if (target.fileId !== fileId) {
    return { outcome: "mismatch", line: `- ❌ **«${lbl}»** — ссылка ведёт к другому файлу (${safeText(target.fileId, 40)})` };
  }
  return {
    outcome: "ok",
    line: `- ✅ **«${lbl}»** — ссылка действует до ${formatLaTime(target.expiresAt)} PT и ведёт к этому файлу; отозвать её нельзя`,
  };
}

registerAutoExecutor("drive_get_download_url", {
  rehash: (addressing, ctx: AutoExecutorCtx) => {
    const p = addressing as DownloadUrlPayload;
    const g = ctx.clients.resolve(p.account);
    return downloadUrlRehash(g, addressing);
  },
  execute: async (payload, auditId, ctx: AutoExecutorCtx) => {
    const p = payload as DownloadUrlPayload;
    const g = ctx.clients.resolve(p.account);
    const result = await executeGetDownloadUrlCore(g, p, auditId, ctx.consentStore);
    return humanReadableAutoExecuteReport(result);
  },
});

export function registerDriveTools(server: McpServer, clients: UserClients, ctx: DriveConsentContext = DEFAULT_CONSENT_CTX) {
  const account = accountField(clients);

  // ── Search (no change — already returns multiple) ──────────────────────────

  server.registerTool(
    "drive_search",
    {
      title: "Search Drive files",
      description:
        "Search files/folders in Drive. Either pass a raw Drive `query` (Drive API q syntax) or use `nameContains`/`mimeType` helpers.",
      inputSchema: {
        account,
        query: z
          .string()
          .optional()
          .describe("Raw Drive query, e.g. \"name contains 'report' and trashed=false\"."),
        nameContains: z.string().optional(),
        mimeType: z
          .string()
          .optional()
          .describe("e.g. application/vnd.google-apps.spreadsheet | .document | .folder"),
        maxResults: z.number().int().min(1).max(200).default(50).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    guard(async ({ account, query, nameContains, mimeType, maxResults }) => {
      const g = clients.resolve(account);
      let q = query;
      if (!q) {
        const parts = ["trashed=false"];
        if (nameContains) parts.push(`name contains '${nameContains.replace(/'/g, "\\'")}'`);
        if (mimeType) parts.push(`mimeType='${mimeType}'`);
        q = parts.join(" and ");
      }
      const res = await g.drive.files.list({
        q,
        pageSize: maxResults ?? 50,
        fields: "files(id,name,mimeType,modifiedTime,webViewLink,parents)",
        orderBy: "modifiedTime desc",
      });
      const files = res.data.files ?? [];
      const scopeDesc = nameContains ? `"${nameContains}"` : query ? `query: ${query}` : "all files";
      return ok({
        summary: `🔍 Drive search for ${scopeDesc}${mimeType ? ` (${mimeType})` : ""} — ${files.length} result(s)`,
        files,
      });
    }),
  );

  // ── Get metadata ───────────────────────────────────────────────────────────

  server.registerTool(
    "drive_get_metadata",
    {
      title: "Get file metadata",
      description: "Get metadata for one or more files by id.",
      inputSchema: {
        account,
        fileIds: z.array(z.string()).min(1).describe("Array of file IDs to fetch metadata for."),
      },
      annotations: { readOnlyHint: true },
    },
    guard(async ({ account, fileIds }) => {
      const g = clients.resolve(account);
      const results = await Promise.all(
        fileIds.map(async (fileId) => {
          try {
            const res = await g.drive.files.get({
              fileId,
              fields:
                "id,name,mimeType,modifiedTime,createdTime,size,owners(emailAddress),webViewLink,parents,trashed",
            });
            return { fileId, ...res.data };
          } catch (e: unknown) {
            return { fileId, error: e instanceof Error ? e.message : String(e) };
          }
        }),
      );
      return ok({
        summary: `ℹ️ Fetched metadata for ${fileIds.length} file(s)`,
        results,
      });
    }),
  );

  // ── Create folders ─────────────────────────────────────────────────────────
  // Two-mode consent-gated tool. Degenerate binding (gate.md §3.3(2) honest
  // exception, same as gmail_send/sheets_create): a folder that doesn't exist
  // yet has no live object to bind against, so objectHash = sha256(payload)
  // on BOTH sides. Post-verify is still real: each created folder is
  // re-fetched by id to confirm it actually exists with the requested name.

  server.registerTool(
    "drive_create_folder",
    {
      title: "Create folders",
      description:
        "Create one or more new folders, optionally inside parent folders. Two-mode consent-gated tool " +
        "(mcp-development-standard/references/gate.md): call WITHOUT `manifest_id`/`user_reply` (with `folders`) " +
        "to build a plan and return a preview — NOTHING is created yet. Show the preview to the user verbatim " +
        "and wait for their reply. Call again with the returned `manifest_id` and the user's VERBATIM " +
        "`user_reply` to actually create — the approved batch is read back from the plan, not from whatever " +
        "`folders` the second call carries.",
      inputSchema: {
        account,
        folders: z
          .array(z.object({ name: z.string(), parentId: z.string().optional() }))
          .optional()
          .describe(
            "Required to build a plan (first call, no manifest_id/user_reply). Ignored on the execute call — " +
              "the approved batch is read back from the manifest.",
          ),
        manifest_id: z
          .string()
          .optional()
          .describe("Id of a plan built by a previous no-argument call. Pass together with `user_reply` to execute it."),
        user_reply: z.string().optional().describe(USER_REPLY_DOC),
        automation_key: z.string().optional().describe(AUTOMATION_KEY_DOC),
      },
      annotations: { destructiveHint: false },
    },
    guard(async ({ account, folders, manifest_id, user_reply, automation_key }) => {
      const { consentStore, consentCfg, tg, checkAutomationKey } = ctx;
      if (!consentStore) {
        return fail(
          "Создание папок недоступно: не настроено хранилище согласия (DATABASE_URL). Без него сервер не может " +
            "провести это действие через гейт подтверждения — обратитесь к администратору сервера.",
        );
      }
      const g = clients.resolve(account);
      const accountName = account ?? clients.defaultName;

      const decision = await requireConsent<CreateFolderPayload>({
        tool: "drive_create_folder",
        accountLabel: accountName,
        manifestId: manifest_id,
        userReply: user_reply,
        store: consentStore,
        cfg: consentCfg,
        tg,
        automationKey: automation_key,
        checkAutomationKey,
        plan: async () => {
          if (!folders || !folders.length) {
            throw new Error("Нужен непустой `folders`, чтобы построить план создания.");
          }
          const payload: CreateFolderPayload = { account: accountName, folders };
          const lines = folders.map(
            (f) => `- **«${safeText(f.name, 80)}»**${f.parentId ? ` внутри ${safeText(f.parentId, 40)}` : ""}`,
          );
          const preview = `### 📤 План: Создание папок — ${folders.length}\n\n${lines.join("\n")}`;
          const objectHash = sha256(payload);
          return { payload, objectHash, preview, batchSize: folders.length };
        },
        rehash: async (addressing) => sha256(addressing as CreateFolderPayload),
      });

      if (decision.kind === "planned") return ok(decision.preview);
      // Исполнено другим каналом во время sync-wait — ОТЧЁТ, не отказ (см. consent.ts).
      if (decision.kind === "already_executed") return okExecutionReport(decision.report);
      if (decision.kind === "refused") return ok(decision.result);

      const { payload, auditId } = decision;
      return executeCreateFolderCore(g, payload, auditId, consentStore);
    }),
  );

  // ── Rename ─────────────────────────────────────────────────────────────────
  // REAL binding: re-reads each file's LIVE current name at plan and again at
  // rehash — a concurrent rename/delete between plan and execute changes the
  // snapshot and trips the drift check (gate.md §3.3(2)).

  server.registerTool(
    "drive_rename",
    {
      title: "Rename files",
      description:
        "Rename one or more files or folders. Two-mode consent-gated tool " +
        "(mcp-development-standard/references/gate.md): call WITHOUT `manifest_id`/`user_reply` (with `items`) " +
        "to build a plan and return a preview — NOTHING is renamed yet. Show the preview to the user verbatim " +
        "and wait for their reply. Call again with the returned `manifest_id` and the user's VERBATIM " +
        "`user_reply` to actually rename.",
      inputSchema: {
        account,
        items: z
          .array(z.object({ fileId: z.string(), newName: z.string() }))
          .optional()
          .describe(
            "Required to build a plan (first call, no manifest_id/user_reply). Ignored on the execute call — " +
              "the approved batch is read back from the manifest.",
          ),
        manifest_id: z
          .string()
          .optional()
          .describe("Id of a plan built by a previous no-argument call. Pass together with `user_reply` to execute it."),
        user_reply: z.string().optional().describe(USER_REPLY_DOC),
        automation_key: z.string().optional().describe(AUTOMATION_KEY_DOC),
      },
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    guard(async ({ account, items, manifest_id, user_reply, automation_key }) => {
      const { consentStore, consentCfg, tg, checkAutomationKey } = ctx;
      if (!consentStore) {
        return fail(
          "Переименование недоступно: не настроено хранилище согласия (DATABASE_URL). Без него сервер не может " +
            "провести это действие через гейт подтверждения — обратитесь к администратору сервера.",
        );
      }
      const g = clients.resolve(account);
      const accountName = account ?? clients.defaultName;

      const decision = await requireConsent<RenamePayload>({
        tool: "drive_rename",
        accountLabel: accountName,
        manifestId: manifest_id,
        userReply: user_reply,
        store: consentStore,
        cfg: consentCfg,
        tg,
        automationKey: automation_key,
        checkAutomationKey,
        plan: async () => {
          if (!items || !items.length) {
            throw new Error("Нужен непустой `items`, чтобы построить план переименования.");
          }
          const snapshot = await renameBindingSnapshot(g, items);
          const payload: RenamePayload = { account: accountName, items };
          const lines = snapshot.map(
            (s) => `- **«${safeText(s.currentName ?? s.fileId, 60)}»** → «${safeText(s.newName, 60)}»`,
          );
          const preview = `### 📤 План: Переименование — ${items.length}\n\n${lines.join("\n")}`;
          const objectHash = sha256({ account: accountName, items: snapshot });
          return { payload, objectHash, preview, batchSize: items.length };
        },
        rehash: (addressing) => renameRehash(g, addressing),
      });

      if (decision.kind === "planned") return ok(decision.preview);
      // Исполнено другим каналом во время sync-wait — ОТЧЁТ, не отказ (см. consent.ts).
      if (decision.kind === "already_executed") return okExecutionReport(decision.report);
      if (decision.kind === "refused") return ok(decision.result);

      const { payload, auditId } = decision;
      return executeRenameCore(g, payload, auditId, consentStore);
    }),
  );

  // ── Move ───────────────────────────────────────────────────────────────────
  // REAL binding: re-reads each file's LIVE current `parents` at plan and
  // again at rehash — someone else moving the file between plan and execute
  // changes the snapshot and trips the drift check. Low priority per
  // Maksim's decision (2026-08-04), still gated like every other write.

  server.registerTool(
    "drive_move",
    {
      title: "Move files",
      description:
        "Move one or more files into different folders. Two-mode consent-gated tool " +
        "(mcp-development-standard/references/gate.md): call WITHOUT `manifest_id`/`user_reply` (with `items`) " +
        "to build a plan and return a preview — NOTHING is moved yet. Show the preview to the user verbatim " +
        "and wait for their reply. Call again with the returned `manifest_id` and the user's VERBATIM " +
        "`user_reply` to actually move.",
      inputSchema: {
        account,
        items: z
          .array(
            z.object({
              fileId: z.string(),
              newParentId: z.string().describe("Destination folder id."),
              removeParentId: z
                .string()
                .optional()
                .describe("Current parent folder id to detach from."),
            }),
          )
          .optional()
          .describe(
            "Required to build a plan (first call, no manifest_id/user_reply). Ignored on the execute call — " +
              "the approved batch is read back from the manifest.",
          ),
        manifest_id: z
          .string()
          .optional()
          .describe("Id of a plan built by a previous no-argument call. Pass together with `user_reply` to execute it."),
        user_reply: z.string().optional().describe(USER_REPLY_DOC),
        automation_key: z.string().optional().describe(AUTOMATION_KEY_DOC),
      },
      annotations: { destructiveHint: false },
    },
    guard(async ({ account, items, manifest_id, user_reply, automation_key }) => {
      const { consentStore, consentCfg, tg, checkAutomationKey } = ctx;
      if (!consentStore) {
        return fail(
          "Перемещение недоступно: не настроено хранилище согласия (DATABASE_URL). Без него сервер не может " +
            "провести это действие через гейт подтверждения — обратитесь к администратору сервера.",
        );
      }
      const g = clients.resolve(account);
      const accountName = account ?? clients.defaultName;

      const decision = await requireConsent<MovePayload>({
        tool: "drive_move",
        accountLabel: accountName,
        manifestId: manifest_id,
        userReply: user_reply,
        store: consentStore,
        cfg: consentCfg,
        tg,
        automationKey: automation_key,
        checkAutomationKey,
        plan: async () => {
          if (!items || !items.length) {
            throw new Error("Нужен непустой `items`, чтобы построить план перемещения.");
          }
          const snapshot = await moveBindingSnapshot(g, items);
          const payload: MovePayload = { account: accountName, items };
          const lines = snapshot.map(
            (s) =>
              `- **${safeText(s.fileId, 40)}** — сейчас в [${s.currentParents.map((p) => safeText(p, 30)).join(", ") || "—"}] → ${safeText(s.newParentId, 40)}` +
              (s.removeParentId ? ` (отвязать от ${safeText(s.removeParentId, 40)})` : ""),
          );
          const preview = `### 📤 План: Перемещение — ${items.length}\n\n${lines.join("\n")}`;
          const objectHash = sha256({ account: accountName, items: snapshot });
          return { payload, objectHash, preview, batchSize: items.length };
        },
        rehash: (addressing) => moveRehash(g, addressing),
      });

      if (decision.kind === "planned") return ok(decision.preview);
      // Исполнено другим каналом во время sync-wait — ОТЧЁТ, не отказ (см. consent.ts).
      if (decision.kind === "already_executed") return okExecutionReport(decision.report);
      if (decision.kind === "refused") return ok(decision.result);

      const { payload, auditId } = decision;
      return executeMoveCore(g, payload, auditId, consentStore);
    }),
  );

  // ── Trash ──────────────────────────────────────────────────────────────────
  // REAL binding: re-reads each file's LIVE {name, parents, trashed} at plan
  // and again at rehash. Pre-snapshot (identity-postverify.md §5.2): the
  // plan-time read IS the "before" snapshot of a necessarily-somewhat-
  // irreversible mutation — captured explicitly and attached to the audit row.

  server.registerTool(
    "drive_trash",
    {
      title: "Move files to trash",
      description:
        "Move one or more files to the trash (reversible). This does NOT permanently delete them. Two-mode " +
        "consent-gated tool (mcp-development-standard/references/gate.md): call WITHOUT `manifest_id`/`user_reply` " +
        "(with `fileIds`) to build a plan and return a preview — NOTHING is trashed yet. Show the preview to the " +
        "user verbatim and wait for their reply. Call again with the returned `manifest_id` and the user's " +
        "VERBATIM `user_reply` to actually trash.",
      inputSchema: {
        account,
        fileIds: z
          .array(z.string())
          .optional()
          .describe(
            "Required to build a plan (first call, no manifest_id/user_reply). Ignored on the execute call — " +
              "the approved batch is read back from the manifest.",
          ),
        manifest_id: z
          .string()
          .optional()
          .describe("Id of a plan built by a previous no-argument call. Pass together with `user_reply` to execute it."),
        user_reply: z.string().optional().describe(USER_REPLY_DOC),
        automation_key: z.string().optional().describe(AUTOMATION_KEY_DOC),
      },
      annotations: { destructiveHint: true },
    },
    guard(async ({ account, fileIds, manifest_id, user_reply, automation_key }) => {
      const { consentStore, consentCfg, tg, checkAutomationKey } = ctx;
      if (!consentStore) {
        return fail(
          "Удаление в Корзину недоступно: не настроено хранилище согласия (DATABASE_URL). Без него сервер не " +
            "может провести это действие через гейт подтверждения — обратитесь к администратору сервера.",
        );
      }
      const g = clients.resolve(account);
      const accountName = account ?? clients.defaultName;

      const decision = await requireConsent<TrashPayload>({
        tool: "drive_trash",
        accountLabel: accountName,
        manifestId: manifest_id,
        userReply: user_reply,
        store: consentStore,
        cfg: consentCfg,
        tg,
        automationKey: automation_key,
        checkAutomationKey,
        plan: async () => {
          if (!fileIds || !fileIds.length) {
            throw new Error("Нужен непустой `fileIds`, чтобы построить план удаления в Корзину.");
          }
          const snapshot = await trashBindingSnapshot(g, fileIds);
          const payload: TrashPayload = { account: accountName, fileIds };
          const lines = snapshot.map((s) => {
            if (s.trashed === null) return `- **${safeText(s.fileId, 40)}** — не удалось прочитать живой файл`;
            if (s.trashed) return `- **«${safeText(s.name ?? s.fileId, 60)}»** — уже в Корзине`;
            return `- **«${safeText(s.name ?? s.fileId, 60)}»**`;
          });
          const preview = `### 📤 План: Удаление в Корзину — ${fileIds.length}\n\n${lines.join("\n")}`;
          const objectHash = sha256({ account: accountName, fileIds, snapshot });
          return { payload, objectHash, preview, batchSize: fileIds.length };
        },
        rehash: (addressing) => trashRehash(g, addressing),
      });

      if (decision.kind === "planned") return ok(decision.preview);
      // Исполнено другим каналом во время sync-wait — ОТЧЁТ, не отказ (см. consent.ts).
      if (decision.kind === "already_executed") return okExecutionReport(decision.report);
      if (decision.kind === "refused") return ok(decision.result);

      const { payload, auditId } = decision;
      return executeTrashCore(g, payload, auditId, consentStore);
    }),
  );

  // ── Upload ─────────────────────────────────────────────────────────────────
  // Two-mode consent-gated tool. Degenerate binding (gate.md §3.3(2) honest
  // exception, same as drive_create_folder above): brand-new files have no
  // live object to bind against, so objectHash = sha256(payload) on BOTH
  // sides. Post-verify is still real: each uploaded file is re-fetched by id.

  server.registerTool(
    "drive_upload_file",
    {
      title: "Upload / create new Drive files",
      description:
        "Create one or more new files in Drive from provided content. " +
        "Only suitable for SMALL files: the content travels inside the tool-call body " +
        "(practical limit ~1 MB). For larger files use drive_create_upload_session + " +
        "drive_confirm_upload, which lets the client PUT the bytes straight to Google. " +
        "To overwrite existing files use drive_overwrite_file instead. " +
        "Pass either `content_text` (UTF-8) or `content_base64` (binary) per file. Two-mode " +
        "consent-gated tool (mcp-development-standard/references/gate.md): call WITHOUT " +
        "`manifest_id`/`user_reply` (with `files`) to build a plan and return a preview — NOTHING is created " +
        "yet. Show the preview to the user verbatim and wait for their reply. Call again with the returned " +
        "`manifest_id` and the user's VERBATIM `user_reply` to actually upload.",
      inputSchema: {
        account,
        files: z
          .array(
            z.object({
              name: z.string().describe("File name, e.g. 'report.pdf'."),
              mimeType: z
                .string()
                .optional()
                .describe("e.g. 'application/pdf', 'text/plain'. Default octet-stream."),
              parentId: z.string().optional().describe("Destination folder id."),
              content_text: z.string().optional(),
              content_base64: z.string().optional(),
            }),
          )
          .optional()
          .describe(
            "Required to build a plan (first call, no manifest_id/user_reply). Ignored on the execute call — " +
              "the approved batch is read back from the manifest.",
          ),
        manifest_id: z
          .string()
          .optional()
          .describe("Id of a plan built by a previous no-argument call. Pass together with `user_reply` to execute it."),
        user_reply: z.string().optional().describe(USER_REPLY_DOC),
        automation_key: z.string().optional().describe(AUTOMATION_KEY_DOC),
      },
      annotations: { destructiveHint: false },
    },
    guard(async ({ account, files, manifest_id, user_reply, automation_key }) => {
      const { consentStore, consentCfg, tg, checkAutomationKey } = ctx;
      if (!consentStore) {
        return fail(
          "Загрузка недоступна: не настроено хранилище согласия (DATABASE_URL). Без него сервер не может " +
            "провести это действие через гейт подтверждения — обратитесь к администратору сервера.",
        );
      }
      const g = clients.resolve(account);
      const accountName = account ?? clients.defaultName;

      const decision = await requireConsent<UploadFilePayload>({
        tool: "drive_upload_file",
        accountLabel: accountName,
        manifestId: manifest_id,
        userReply: user_reply,
        store: consentStore,
        cfg: consentCfg,
        tg,
        automationKey: automation_key,
        checkAutomationKey,
        plan: async () => {
          if (!files || !files.length) {
            throw new Error("Нужен непустой `files`, чтобы построить план загрузки.");
          }
          const payload: UploadFilePayload = { account: accountName, files };
          const lines = files.map((f) => {
            const bytes = f.content_base64
              ? Math.ceil((f.content_base64.length * 3) / 4)
              : Buffer.byteLength(f.content_text ?? "", "utf8");
            return (
              `- **«${safeText(f.name, 80)}»** (${f.mimeType ?? "application/octet-stream"}, ~${bytes} байт)` +
              (f.parentId ? ` внутри ${safeText(f.parentId, 40)}` : "")
            );
          });
          const preview = `### 📤 План: Загрузка файлов — ${files.length}\n\n${lines.join("\n")}`;
          const objectHash = sha256(payload);
          return { payload, objectHash, preview, batchSize: files.length };
        },
        rehash: async (addressing) => sha256(addressing as UploadFilePayload),
      });

      if (decision.kind === "planned") return ok(decision.preview);
      // Исполнено другим каналом во время sync-wait — ОТЧЁТ, не отказ (см. consent.ts).
      if (decision.kind === "already_executed") return okExecutionReport(decision.report);
      if (decision.kind === "refused") return ok(decision.result);

      const { payload, auditId } = decision;
      return executeUploadFileCore(g, payload, auditId, consentStore);
    }),
  );

  // ── Resumable upload: create session ──────────────────────────────────────
  // Two-mode consent-gated tool. This is where the gate has to bind, not
  // drive_confirm_upload: the actual BYTES are PUT by the CLIENT straight to
  // Google afterwards, bypassing this server entirely — by the time
  // drive_confirm_upload is called, any replace has already happened. So the
  // gate covers "starting the upload machinery" (new file OR replace-target
  // selection), which is the only point this server is actually in the loop.
  // Binding: for a REPLACE (`fileId` given) this is a REAL rehash of the live
  // target file's {name, mimeType, md5Checksum} — a concurrent overwrite
  // between plan and execute trips drift. For a brand-new file (no `fileId`)
  // there is no live object yet — the same documented degenerate case as
  // drive_create_folder/drive_upload_file.

  server.registerTool(
    "drive_create_upload_session",
    {
      title: "Create resumable upload sessions (large files)",
      description:
        "Start one or more Google Drive resumable uploads and return a temporary upload URL " +
        "(resumable session URI) per file. The CLIENT then PUTs the raw file bytes directly to " +
        "that URL — the server never proxies the file, so nothing large travels through the " +
        "tool-call body. Use this for files bigger than ~1 MB, where drive_upload_file is not " +
        "usable (there the whole content is sent as base64 inside the call). Each session URI " +
        "stays valid for about a week (see the machine-readable `expiresAt`). Pass `fileId` to " +
        "replace the content of an existing file instead of creating a new one. After the bytes " +
        "are uploaded, call drive_confirm_upload with the same uploadUrl to check status and get " +
        "the final fileId. Every result carries a `howTo` string with the exact PUT headers. " +
        "Two-mode consent-gated tool (mcp-development-standard/references/gate.md): call WITHOUT " +
        "`manifest_id`/`user_reply` (with `files`) to build a plan and return a preview — NO session is created " +
        "yet. Show the preview to the user verbatim and wait for their reply. Call again with the returned " +
        "`manifest_id` and the user's VERBATIM `user_reply` to actually create the session(s).",
      inputSchema: {
        account,
        files: z
          .array(
            z.object({
              name: z
                .string()
                .optional()
                .describe(
                  "File name, e.g. 'video.mp4'. Required for a new file; with `fileId` it renames " +
                    "the file — omit it to keep the current name.",
                ),
              mimeType: z
                .string()
                .optional()
                .describe(
                  `Content type of the bytes the client will upload. Default ${DEFAULT_UPLOAD_MIME}.`,
                ),
              sizeBytes: z
                .number()
                .int()
                .positive()
                .optional()
                .describe(
                  "Total size in bytes, if known. Lets Google validate the upload; when omitted " +
                    "the client must send '*' as the total until the final chunk.",
                ),
              parentId: z
                .string()
                .optional()
                .describe("Destination folder id (new files only; use drive_move to reparent)."),
              fileId: z
                .string()
                .optional()
                .describe(
                  "Id of an existing file to REPLACE (destructive: the previous content is lost).",
                ),
            }),
          )
          .optional()
          .describe(
            "Required to build a plan (first call, no manifest_id/user_reply). Ignored on the execute call — " +
              "the approved batch is read back from the manifest.",
          ),
        manifest_id: z
          .string()
          .optional()
          .describe("Id of a plan built by a previous no-argument call. Pass together with `user_reply` to execute it."),
        user_reply: z.string().optional().describe(USER_REPLY_DOC),
        automation_key: z.string().optional().describe(AUTOMATION_KEY_DOC),
      },
      annotations: { destructiveHint: false },
    },
    guard(async ({ account, files, manifest_id, user_reply, automation_key }) => {
      const { consentStore, consentCfg, tg, checkAutomationKey } = ctx;
      if (!consentStore) {
        return fail(
          "Создание сессии загрузки недоступно: не настроено хранилище согласия (DATABASE_URL). Без него " +
            "сервер не может провести это действие через гейт подтверждения — обратитесь к администратору сервера.",
        );
      }
      const g = clients.resolve(account);
      const accountName = account ?? clients.defaultName;

      const decision = await requireConsent<UploadSessionPayload>({
        tool: "drive_create_upload_session",
        accountLabel: accountName,
        manifestId: manifest_id,
        userReply: user_reply,
        store: consentStore,
        cfg: consentCfg,
        tg,
        automationKey: automation_key,
        checkAutomationKey,
        plan: async () => {
          if (!files || !files.length) {
            throw new Error("Нужен непустой `files`, чтобы построить план создания сессии загрузки.");
          }
          const snapshot = await uploadSessionBindingSnapshot(g, files);
          const payload: UploadSessionPayload = { account: accountName, files };
          const lines = snapshot.map((f) => {
            if (f.fileId) {
              const live = f.liveTarget;
              return live
                ? `- **ЗАМЕНА «${safeText(live.name, 60)}»** (${safeText(f.fileId, 40)}, сейчас ${safeText(live.mimeType, 40)}) — предыдущее содержимое будет потеряно`
                : `- **ЗАМЕНА ${safeText(f.fileId, 40)}** — не удалось прочитать текущий файл`;
            }
            return `- **«${safeText(f.name ?? "(без имени)", 60)}»** — новый файл${f.parentId ? ` внутри ${safeText(f.parentId, 40)}` : ""}`;
          });
          const preview = `### 📤 План: Сессия(и) загрузки — ${files.length}\n\n${lines.join("\n")}`;
          const objectHash = sha256({ account: accountName, files: snapshot });
          return { payload, objectHash, preview, batchSize: files.length };
        },
        rehash: (addressing) => uploadSessionRehash(g, addressing),
      });

      if (decision.kind === "planned") return ok(decision.preview);
      // Исполнено другим каналом во время sync-wait — ОТЧЁТ, не отказ (см. consent.ts).
      if (decision.kind === "already_executed") return okExecutionReport(decision.report);
      if (decision.kind === "refused") return ok(decision.result);

      const { payload, auditId } = decision;
      return executeUploadSessionCore(g, payload, auditId, consentStore);
    }),
  );

  // ── Resumable upload: confirm / check status ──────────────────────────────
  // NOT gated — deliberate. This tool does not mutate anything: it's a status
  // QUERY (a zero-length PUT with "bytes */<total>", i.e. Content-Range as a
  // range probe) against a session Google already finalised (or not) the
  // moment the CLIENT's own direct PUT of bytes to Google completed — an
  // event this server was never a party to. Calling drive_confirm_upload
  // zero, one, or many times changes nothing server-side; it only reads back
  // what already happened. The actual write is gated at session-creation
  // time (drive_create_upload_session above), which is the last point this
  // server is in control before bytes start moving client→Google directly.
  //
  // ЧТО ЗДЕСЬ ИСПРАВЛЕНО (задача #112). Раньше этот инструмент принимал
  // `uploadUrl` — АДРЕС, ПРИШЕДШИЙ В АРГУМЕНТЕ, — и шёл по нему без единой
  // проверки. Это давало подделку запроса со стороны сервера (SSRF): модель,
  // которой скормили нужный текст, заставляла сервер постучаться во
  // внутреннюю сеть (метаданные облака, приватные диапазоны, localhost) и
  // вернуть ответ наружу. Теперь адрес не принимается ВООБЩЕ: сервер сам
  // выдал его при создании сессии, сам и хранит (uploadSessions.ts), а
  // наружу отдаёт только непрозрачный `sessionId`. Плюс второй рубеж —
  // safeGoogleFetch (allowlist хостов Google + запрет приватных адресов на
  // уровне реального соединения + проверка каждого перенаправления).

  server.registerTool(
    "drive_confirm_upload",
    {
      title: "Check / confirm a resumable upload",
      description:
        "Query the status of one or more resumable upload sessions created by " +
        "drive_create_upload_session. Pass the `sessionId` each session returned — the upload " +
        "address itself is kept server-side and is NOT accepted as an argument. If the upload " +
        "finished, returns the final fileId together with the file name, mimeType and " +
        "webViewLink. If it is still incomplete, reports how many bytes Google has already " +
        "accepted so the client can resume from that offset. A session that Google no longer " +
        "knows about (404/410 Gone) comes back as status='expired'.",
      inputSchema: {
        account,
        sessions: z
          .array(
            z.object({
              sessionId: z
                .string()
                .describe(
                  "The opaque `sessionId` returned by drive_create_upload_session. NOT a URL: " +
                    "the server looks the real upload address up in its own store.",
                ),
              sizeBytes: z
                .number()
                .int()
                .positive()
                .optional()
                .describe("Total size in bytes, if known — improves the status check."),
            }),
          )
          .min(1)
          .describe("Array of upload sessions to check."),
      },
      // Server-side this mutates nothing — it reads back an upload that already
      // happened. But it does so with a real OUTBOUND request (safeGoogleFetch),
      // so `readOnlyHint: true` — which it carried until 2026-08-06 — was never
      // true in the sense the annotation implies. That matters beyond tidiness:
      // a reflexive gate-coverage test classifies tools by that annotation, so
      // a self-declared "read" is invisible to it. The address no longer comes
      // from the model (opaque sessionId + server-side store) and the outbound
      // call is host-pinned, so no gate is warranted — the honest label is
      // "not read-only, deliberately ungated", matching gmail_confirm_upload.
      annotations: { openWorldHint: true },
    },
    guard(async ({ account, sessions }) => {
      const results = await Promise.all(
        sessions.map(async ({ sessionId, sizeBytes }) => {
          const session = await resolveUploadSession(sessionId);
          if (!session) {
            return {
              sessionId,
              error:
                "Сессия загрузки с таким `sessionId` не найдена (истекла или её создавал не этот сервер). " +
                "Создайте новую через drive_create_upload_session.",
            };
          }
          // Аккаунт берём ИЗ ЗАПИСИ СЕССИИ, а не из аргумента: сессия
          // принадлежит тому аккаунту, под которым её создавали.
          const g = clients.resolve(session.account ?? account);
          try {
            // A zero-length PUT with "bytes */<total>" asks Google for the current status;
            // the session URI itself carries the upload_id, so no Authorization is needed.
            const res = await safeGoogleFetch(session.uploadUrl, {
              method: "PUT",
              headers: {
                "Content-Range": `bytes */${sizeBytes ?? session.sizeBytes ?? "*"}`,
                "Content-Length": "0",
              },
            });

            if (res.status === 200 || res.status === 201) {
              // The session was created with `fields=`, so the finalising response already
              // carries the metadata — no extra files.get in the common case.
              let fileId: string | null = null;
              let name: string | null = null;
              let mimeType: string | null = null;
              let size: string | null = null;
              let webViewLink: string | null = null;
              try {
                const body = (await res.json()) as {
                  id?: string;
                  name?: string;
                  mimeType?: string;
                  size?: string;
                  webViewLink?: string;
                };
                fileId = body.id ?? null;
                name = body.name ?? null;
                mimeType = body.mimeType ?? null;
                size = body.size ?? null;
                webViewLink = body.webViewLink ?? null;
              } catch {
                /* body may be empty — fall back to metadata below */
              }
              if (fileId && !webViewLink) {
                try {
                  const meta = await g.drive.files.get({
                    fileId,
                    fields: UPLOAD_FIELDS,
                  });
                  name = meta.data.name ?? name;
                  mimeType = meta.data.mimeType ?? mimeType;
                  size = meta.data.size ?? size;
                  webViewLink = meta.data.webViewLink ?? null;
                } catch {
                  /* metadata lookup is best-effort — return what we already have */
                }
              }
              return {
                sessionId,
                status: "completed" as const,
                fileId,
                name,
                mimeType,
                size,
                webViewLink,
              };
            }

            if (res.status === 308) {
              // "Resume Incomplete": Range: bytes=0-N tells how much Google stored.
              const range = res.headers.get("range");
              const end = range ? Number(range.split("-")[1]) : NaN;
              const bytesReceived = Number.isFinite(end) ? end + 1 : 0;
              return {
                sessionId,
                status: "incomplete" as const,
                bytesReceived,
                nextOffset: bytesReceived,
                hint:
                  "Client should PUT the remaining bytes with " +
                  `Content-Range: bytes <nextOffset>-<end>/${sizeBytes ?? "<total>"}.`,
              };
            }

            if (res.status === 404 || res.status === 410) {
              return {
                sessionId,
                status: "expired" as const,
                error:
                  "Upload session is gone (expired or already finalised). Create a new session.",
              };
            }

            return { sessionId, error: `Google returned ${res.status}: ${await errorBody(res)}` };
          } catch (e: unknown) {
            return { sessionId, error: e instanceof Error ? e.message : String(e) };
          }
        }),
      );
      return ok({
        summary: `🔎 Checked ${sessions.length} resumable upload session(s)`,
        results,
      });
    }),
  );

  // ── Overwrite ──────────────────────────────────────────────────────────────
  // REAL binding: re-reads each target's LIVE {name, mimeType, md5Checksum,
  // modifiedTime} at plan and again at rehash — a concurrent edit between
  // plan and execute changes the snapshot and trips the drift check.
  // Pre-snapshot (identity-postverify.md §5.2): the plan-time read of
  // md5Checksum/modifiedTime IS the "before" state, captured explicitly and
  // attached to the audit row (this is what makes the loss of the old
  // content honestly recorded, even though Drive itself keeps no old-content
  // backup here).

  server.registerTool(
    "drive_overwrite_file",
    {
      title: "Overwrite existing Drive files",
      description:
        "Replace the content of one or more existing Drive files by their ids. " +
        "This is destructive — the previous content is lost (unless versioned first). " +
        "Pass either `content_text` (UTF-8) or `content_base64` (binary) per file. Two-mode consent-gated " +
        "tool (mcp-development-standard/references/gate.md): call WITHOUT `manifest_id`/`user_reply` (with " +
        "`files`) to build a plan and return a preview — NOTHING is overwritten yet. Show the preview to the " +
        "user verbatim and wait for their reply. Call again with the returned `manifest_id` and the user's " +
        "VERBATIM `user_reply` to actually overwrite.",
      inputSchema: {
        account,
        files: z
          .array(
            z.object({
              fileId: z.string().describe("Id of the file to overwrite."),
              mimeType: z.string().optional().describe("e.g. 'application/pdf', 'text/plain'."),
              content_text: z.string().optional(),
              content_base64: z.string().optional(),
            }),
          )
          .optional()
          .describe(
            "Required to build a plan (first call, no manifest_id/user_reply). Ignored on the execute call — " +
              "the approved batch is read back from the manifest.",
          ),
        manifest_id: z
          .string()
          .optional()
          .describe("Id of a plan built by a previous no-argument call. Pass together with `user_reply` to execute it."),
        user_reply: z.string().optional().describe(USER_REPLY_DOC),
        automation_key: z.string().optional().describe(AUTOMATION_KEY_DOC),
      },
      annotations: { destructiveHint: true },
    },
    guard(async ({ account, files, manifest_id, user_reply, automation_key }) => {
      const { consentStore, consentCfg, tg, checkAutomationKey } = ctx;
      if (!consentStore) {
        return fail(
          "Перезапись недоступна: не настроено хранилище согласия (DATABASE_URL). Без него сервер не может " +
            "провести это действие через гейт подтверждения — обратитесь к администратору сервера.",
        );
      }
      const g = clients.resolve(account);
      const accountName = account ?? clients.defaultName;

      const decision = await requireConsent<OverwritePayload>({
        tool: "drive_overwrite_file",
        accountLabel: accountName,
        manifestId: manifest_id,
        userReply: user_reply,
        store: consentStore,
        cfg: consentCfg,
        tg,
        automationKey: automation_key,
        checkAutomationKey,
        plan: async () => {
          if (!files || !files.length) {
            throw new Error("Нужен непустой `files`, чтобы построить план перезаписи.");
          }
          const snapshot = await overwriteBindingSnapshot(g, files);
          const payload: OverwritePayload = { account: accountName, files };
          const lines = snapshot.map((s) => {
            const bytes = files.find((f) => f.fileId === s.fileId)?.content_base64
              ? Math.ceil((files.find((f) => f.fileId === s.fileId)!.content_base64!.length * 3) / 4)
              : Buffer.byteLength(files.find((f) => f.fileId === s.fileId)?.content_text ?? "", "utf8");
            return `- **«${safeText(s.name ?? s.fileId, 60)}»** (сейчас ${s.size ?? "?"} байт, ${safeText(s.liveMimeType ?? "", 40)}) — заменится на ~${bytes} байт`;
          });
          const preview = `### 📤 План: Перезапись — ${files.length}\n\n${lines.join("\n")}`;
          const objectHash = sha256({ account: accountName, files: snapshot });
          return { payload, objectHash, preview, batchSize: files.length };
        },
        rehash: (addressing) => overwriteRehash(g, addressing),
      });

      if (decision.kind === "planned") return ok(decision.preview);
      // Исполнено другим каналом во время sync-wait — ОТЧЁТ, не отказ (см. consent.ts).
      if (decision.kind === "already_executed") return okExecutionReport(decision.report);
      if (decision.kind === "refused") return ok(decision.result);

      const { payload, auditId } = decision;
      return executeOverwriteCore(g, payload, auditId, consentStore);
    }),
  );

  // ── Download ───────────────────────────────────────────────────────────────

  server.registerTool(
    "drive_download_file",
    {
      title: "Download / read Drive files",
      description:
        "Read one or more Drive files' content. Text files are returned as text; Google Docs/Sheets/Slides are exported " +
        "(default: doc→text, sheet→csv, else pdf); other binaries are returned as base64 (size-limited). " +
        "Use this when the CONTENT itself is needed in the conversation. When the user just wants the file " +
        "(big, binary, or to keep), use drive_get_download_url so the client fetches it directly.",
      inputSchema: {
        account,
        files: z
          .array(
            z.object({
              fileId: z.string(),
              exportMimeType: z
                .string()
                .optional()
                .describe("Override export format for Google-native files, e.g. 'application/pdf'."),
            }),
          )
          .min(1)
          .describe("Array of files to download."),
        maxBytes: z
          .number()
          .int()
          .min(1)
          .max(8_000_000)
          .default(750_000)
          .optional()
          .describe("Max bytes to inline for binary content (base64). Default ~0.75MB."),
      },
      annotations: { readOnlyHint: true },
    },
    guard(async ({ account, files, maxBytes }) => {
      const g = clients.resolve(account);
      const limit = maxBytes ?? 750_000;
      const results = await Promise.all(
        files.map(async ({ fileId, exportMimeType }) => {
          try {
            const meta = await g.drive.files.get({ fileId, fields: "id,name,mimeType,size" });
            const mime = meta.data.mimeType ?? "";
            let buf: Buffer;
            let outMime: string;
            if (mime.startsWith("application/vnd.google-apps.")) {
              outMime = exportMimeType ?? defaultExportMime(mime);
              const res = await g.drive.files.export(
                { fileId, mimeType: outMime },
                { responseType: "arraybuffer" },
              );
              buf = Buffer.from(res.data as ArrayBuffer);
            } else {
              outMime = mime;
              const res = await g.drive.files.get(
                { fileId, alt: "media" },
                { responseType: "arraybuffer" },
              );
              buf = Buffer.from(res.data as ArrayBuffer);
            }
            if (isTextual(outMime)) {
              return {
                fileId,
                name: meta.data.name ?? null,
                mimeType: outMime,
                content: buf.toString("utf8"),
                encoding: "text" as const,
              };
            }
            if (buf.length > limit) {
              return {
                fileId,
                error: `File is ${buf.length} bytes (binary) — too large to inline. Raise maxBytes (max 8MB).`,
              };
            }
            return {
              fileId,
              name: meta.data.name ?? null,
              mimeType: outMime,
              content: buf.toString("base64"),
              encoding: "base64" as const,
            };
          } catch (e: unknown) {
            return { fileId, error: e instanceof Error ? e.message : String(e) };
          }
        }),
      );
      return ok({
        summary: `⬇️ Downloaded ${files.length} file(s)`,
        results,
      });
    }),
  );

  // ── Download links (client fetches the bytes itself) ───────────────────────

  server.registerTool(
    "drive_get_download_url",
    {
      title: "Выдать ссылку-доступ на скачивание файла (кто угодно с ссылкой скачает)",
      description:
        "Hand out a temporary download link per file so the client (phone, browser, script) can fetch the bytes " +
        "directly, instead of drive_download_file inlining them into this conversation. Use it for anything large " +
        "or binary, or whenever the user wants to keep the file rather than read its content here. " +
        "Google-native files (Docs/Sheets/Slides) are exported on the fly — default doc→text, sheet→csv, else pdf; " +
        "override with exportMimeType. " +
        "THIS IS NOT A READ: the link IS the credential. Anyone holding it downloads that file with NO sign-in " +
        `and no permissions, and the link CANNOT be revoked — it works until it expires (default ${DEFAULT_TTL_MINUTES} ` +
        `minutes, max ${MAX_TTL_MINUTES / 60} hours). Leaking it into a log, a chat, or another context is equivalent ` +
        "to leaking the file itself. That is why it is a two-mode consent-gated tool " +
        "(mcp-development-standard/references/gate.md): call WITHOUT `manifest_id`/`user_reply` (with `files`) to " +
        "build a plan and return a preview — NO link is issued yet. Show the preview to the user verbatim and wait " +
        "for their reply. Call again with the returned `manifest_id` and the user's VERBATIM `user_reply` to " +
        "actually issue the link(s).",
      inputSchema: {
        account,
        files: z
          .array(
            z.object({
              fileId: z.string(),
              exportMimeType: z
                .string()
                .optional()
                .describe("Override export format for Google-native files, e.g. 'application/pdf'."),
            }),
          )
          .optional()
          .describe(
            "Required to build a plan (first call, no manifest_id/user_reply). Ignored on the execute call — " +
              "the approved batch is read back from the manifest.",
          ),
        ttlMinutes: z
          .number()
          .int()
          .min(1)
          .max(MAX_TTL_MINUTES)
          .optional()
          .describe(`How long each link stays valid. Default ${DEFAULT_TTL_MINUTES} minutes.`),
        manifest_id: z
          .string()
          .optional()
          .describe("Id of a plan built by a previous no-argument call. Pass together with `user_reply` to execute it."),
        user_reply: z.string().optional().describe(USER_REPLY_DOC),
        automation_key: z.string().optional().describe(AUTOMATION_KEY_DOC),
      },
      annotations: { destructiveHint: false },
    },
    guard(async ({ account, files, ttlMinutes, manifest_id, user_reply, automation_key }) => {
      if (!downloadsAvailable()) {
        return fail(
          "Download links are unavailable: this server does not know its own public URL. " +
            "Set PUBLIC_BASE_URL (on Railway, turn on public networking). " +
            "drive_download_file still works for small files.",
        );
      }
      const { consentStore, consentCfg, tg, checkAutomationKey } = ctx;
      if (!consentStore) {
        return fail(
          "Выдача ссылок недоступна: не настроено хранилище согласия (DATABASE_URL). Без него сервер не может " +
            "провести это действие через гейт подтверждения — обратитесь к администратору сервера.",
        );
      }
      const g = clients.resolve(account);
      const accountName = account ?? clients.defaultName;
      const ttl = ttlMinutes ?? DEFAULT_TTL_MINUTES;

      const decision = await requireConsent<DownloadUrlPayload>({
        tool: "drive_get_download_url",
        accountLabel: accountName,
        manifestId: manifest_id,
        userReply: user_reply,
        store: consentStore,
        cfg: consentCfg,
        tg,
        automationKey: automation_key,
        checkAutomationKey,
        plan: async () => {
          if (!files || !files.length) {
            throw new Error("Нужен непустой `files`, чтобы построить план выдачи ссылок.");
          }
          const snapshot = await downloadUrlBindingSnapshot(g, files);
          const payload: DownloadUrlPayload = { account: accountName, ttlMinutes: ttl, files };
          const lines = snapshot.map((s) => {
            const native = (s.mimeType ?? "").startsWith("application/vnd.google-apps.");
            const exported = native ? s.exportMimeType ?? defaultExportMime(s.mimeType ?? "") : null;
            const head = `- **«${safeText(s.name ?? s.fileId, 60)}»**`;
            if (s.name === null) return `${head} — не удалось прочитать файл ${safeText(s.fileId, 40)}`;
            const what = exported
              ? `будет выгружен как ${safeText(exported, 40)}`
              : `${safeText(s.mimeType ?? "", 40)}, ${s.size ?? "?"} байт`;
            return `${head} (${what})${s.trashed ? " — ⚠️ файл в корзине" : ""}`;
          });
          const preview =
            `### 📤 План: Выдать ссылки на скачивание — ${files.length}\n\n` +
            `${downloadUrlConsentWarning(ttl, Date.now() + ttl * 60_000)}\n\n` +
            `${lines.join("\n")}\n\n` +
            `${downloadUrlConsentButtonLine(files.length, ttl)}`;
          const objectHash = sha256({ account: accountName, ttlMinutes: ttl, files: snapshot });
          return { payload, objectHash, preview, batchSize: files.length };
        },
        rehash: (addressing) => downloadUrlRehash(g, addressing),
      });

      if (decision.kind === "planned") return ok(decision.preview);
      // Исполнено другим каналом во время sync-wait — ОТЧЁТ, не отказ (см. consent.ts).
      if (decision.kind === "already_executed") return okExecutionReport(decision.report);
      if (decision.kind === "refused") return ok(decision.result);

      const { payload, auditId } = decision;
      return executeGetDownloadUrlCore(g, payload, auditId, consentStore);
    }),
  );

  // ── Extract text (OCR) ─────────────────────────────────────────────────────
  // NOT gated — a deliberate, and NARROW, exemption. Rationale: OCR is a
  // routine read ("what does this scanned invoice say?"); a plan/confirm
  // round-trip on every such question trains the owner to rubber-stamp
  // confirmations, which is how a gate quietly stops being a gate.
  //
  // What this tool is NOT is read-only, and it no longer claims to be. Drive's
  // OCR physically requires materialising a REAL Google Doc copy in the
  // owner's Drive (it costs quota, shows up in the activity feed and in
  // "Recent"), and for a file someone merely SHARED with the owner that copy is
  // a new object in the owner's Drive. `readOnlyHint: true` used to hide all of
  // that from scripts/test-gate-coverage.mjs — which is exactly why the
  // allowlist entry there never fired. The annotation is gone; the tool is now
  // classified as a write by the source scan and must stay accounted for in
  // that test's UNGATED_WRITE_ALLOWLIST, with a reason.
  //
  // Three properties are what make the exemption defensible rather than a
  // hidden hole (see cleanupOcrTempDoc above):
  //  1. the temp copy goes to the TRASH, never files.delete — irreversible
  //     deletion must not be a side effect of reading text;
  //  2. an identity guard re-reads the copy first and refuses to touch anything
  //     that is not our own "gmcp-ocr-tmp" Google Doc;
  //  3. a cleanup that fails is REPORTED in this tool's own result (id + error)
  //     as well as logged — garbage the user is told about can be removed;
  //     garbage swallowed by `.catch(() => {})` accumulates forever unseen.

  server.registerTool(
    "drive_extract_text",
    {
      title: "Extract text from PDFs/images (OCR)",
      description:
        "Extract text from one or more Drive files (PDF, scan, or image) using Google Drive's built-in OCR. " +
        "NOT a pure read: Google's OCR only works on a Google Doc, so this makes a temporary Google Doc copy " +
        `("${OCR_TEMP_NAME}") in YOUR Drive for each file, reads the text, then moves that copy to the trash. ` +
        "If a copy cannot be cleaned up, the result says so explicitly and names the leftover file id.",
      inputSchema: {
        account,
        fileIds: z.array(z.string()).min(1).describe("Array of Drive file IDs (PDFs/images)."),
        ocrLanguage: z
          .string()
          .optional()
          .describe("Optional language hint, e.g. 'en', 'ru'. Improves OCR accuracy."),
      },
      // No readOnlyHint: this creates and trashes a real Drive file. Reversible
      // (trash, not permanent delete) → destructiveHint: false.
      annotations: { destructiveHint: false },
    },
    guard(async ({ account, fileIds, ocrLanguage }) => {
      const g = clients.resolve(account);
      const leftovers: OcrCleanupFailure[] = [];
      const results = await mapWithLimit(fileIds, async (fileId) => {
        let docId: string | null = null;
        try {
          const copy = await g.drive.files.copy({
            fileId,
            ocrLanguage,
            requestBody: { name: OCR_TEMP_NAME, mimeType: GOOGLE_DOC_MIME },
            fields: "id",
          });
          docId = copy.data.id ?? null;
          if (!docId) {
            throw new Error("Google Drive did not return a file id for the temporary OCR copy.");
          }
          const doc = await g.docs.documents.get({ documentId: docId });
          const text = documentToPlainText(doc.data);
          return { fileId, text };
        } catch (e: unknown) {
          return { fileId, error: e instanceof Error ? e.message : String(e) };
        } finally {
          if (docId) {
            const failure = await cleanupOcrTempDoc(g, docId, "drive_extract_text");
            if (failure) leftovers.push(failure);
          }
        }
      });
      return ok({
        summary: `📄 Extracted text from ${fileIds.length} file(s) via OCR`,
        ...(leftovers.length ? { warning: ocrLeftoverWarning(leftovers), leftoverTempFiles: leftovers } : {}),
        results,
      });
    }),
  );

  // ── Permissions ───────────────────────────────────────────────────────────

  server.registerTool(
    "drive_get_permissions",
    {
      title: "Get file permissions",
      description: "List all sharing permissions (who has access) for one or more Drive files or folders.",
      inputSchema: {
        account,
        fileIds: z.array(z.string()).min(1).describe("Array of file or folder IDs."),
      },
      annotations: { readOnlyHint: true },
    },
    guard(async ({ account, fileIds }) => {
      const g = clients.resolve(account);
      const results = await Promise.all(
        fileIds.map(async (fileId) => {
          try {
            const res = await g.drive.permissions.list({
              fileId,
              fields: "permissions(id,type,role,emailAddress,displayName,domain,expirationTime)",
            });
            return { fileId, permissions: res.data.permissions ?? [] };
          } catch (e: unknown) {
            return { fileId, error: e instanceof Error ? e.message : String(e) };
          }
        }),
      );
      return ok({
        summary: `🔐 Fetched permissions for ${fileIds.length} file(s)`,
        results,
      });
    }),
  );

  // ── Share ──────────────────────────────────────────────────────────────────
  // REAL binding: re-reads each target's LIVE {name, permissions} at plan and
  // again at rehash — someone else changing access (or the file itself)
  // between plan and execute trips the drift check. Necessarily-important
  // per Maksim's decision (access to files!) — post-verify below RE-READS
  // permissions.list, it does not just trust the create() response.

  server.registerTool(
    "drive_share",
    {
      title: "Share files / set permissions",
      description:
        "Share one or more Drive files or folders with users, groups, domains, or make them public. " +
        "Use role='reader'|'commenter'|'writer'|'fileOrganizer'|'organizer'|'owner'. " +
        "Set sendNotificationEmail=false to share silently. Two-mode consent-gated tool " +
        "(mcp-development-standard/references/gate.md): call WITHOUT `manifest_id`/`user_reply` (with `items`) " +
        "to build a plan and return a preview — NOBODY is granted access yet. Show the preview to the user " +
        "verbatim and wait for their reply. Call again with the returned `manifest_id` and the user's VERBATIM " +
        "`user_reply` to actually share.",
      inputSchema: {
        account,
        items: z
          .array(
            z.object({
              fileId: z.string().describe("File or folder ID."),
              role: z
                .enum(["reader", "commenter", "writer", "fileOrganizer", "organizer", "owner"])
                .describe("Access level to grant."),
              type: z
                .enum(["user", "group", "domain", "anyone"])
                .describe("Who to grant access to."),
              emailAddress: z
                .string()
                .optional()
                .describe("Email of the user or group (required when type=user or group)."),
              domain: z
                .string()
                .optional()
                .describe("Domain name (required when type=domain, e.g. 'example.com')."),
              sendNotificationEmail: z
                .boolean()
                .default(false)
                .optional()
                .describe("Send email notification to the recipient (default: false)."),
              emailMessage: z
                .string()
                .optional()
                .describe("Custom message to include in the notification email."),
              transferOwnership: z
                .boolean()
                .default(false)
                .optional()
                .describe("Transfer ownership (only for role=owner, same domain)."),
            }),
          )
          .optional()
          .describe(
            "Required to build a plan (first call, no manifest_id/user_reply). Ignored on the execute call — " +
              "the approved batch is read back from the manifest.",
          ),
        manifest_id: z
          .string()
          .optional()
          .describe("Id of a plan built by a previous no-argument call. Pass together with `user_reply` to execute it."),
        user_reply: z.string().optional().describe(USER_REPLY_DOC),
        automation_key: z.string().optional().describe(AUTOMATION_KEY_DOC),
      },
      annotations: { destructiveHint: true },
    },
    guard(async ({ account, items, manifest_id, user_reply, automation_key }) => {
      const { consentStore, consentCfg, tg, checkAutomationKey } = ctx;
      if (!consentStore) {
        return fail(
          "Открытие доступа недоступно: не настроено хранилище согласия (DATABASE_URL). Без него сервер не " +
            "может провести это действие через гейт подтверждения — обратитесь к администратору сервера.",
        );
      }
      const g = clients.resolve(account);
      const accountName = account ?? clients.defaultName;

      const decision = await requireConsent<SharePayload>({
        tool: "drive_share",
        accountLabel: accountName,
        manifestId: manifest_id,
        userReply: user_reply,
        store: consentStore,
        cfg: consentCfg,
        tg,
        automationKey: automation_key,
        checkAutomationKey,
        plan: async () => {
          if (!items || !items.length) {
            throw new Error("Нужен непустой `items`, чтобы построить план открытия доступа.");
          }
          for (const it of items) {
            if ((it.type === "user" || it.type === "group") && !it.emailAddress) {
              throw new Error(`emailAddress is required when type="${it.type}".`);
            }
            if (it.type === "domain" && !it.domain) {
              throw new Error(`domain is required when type="domain".`);
            }
          }
          const snapshot = await shareBindingSnapshot(g, items);
          const payload: SharePayload = { account: accountName, items };
          const lines = items.map((it, i) => {
            const who = it.emailAddress ?? it.domain ?? (it.type === "anyone" ? "кого угодно" : it.type);
            const cur = snapshot[i];
            return (
              `- **«${safeText(cur.name ?? it.fileId, 60)}»** — выдать ${it.role} для ${safeText(who, 60)}` +
              ` _(сейчас ${cur.permissions.length} право(а) доступа)_`
            );
          });
          const preview = `### 📤 План: Открытие доступа — ${items.length}\n\n${lines.join("\n")}`;
          const objectHash = sha256({ account: accountName, items, snapshot });
          return { payload, objectHash, preview, batchSize: items.length };
        },
        rehash: (addressing) => shareRehash(g, addressing),
      });

      if (decision.kind === "planned") return ok(decision.preview);
      // Исполнено другим каналом во время sync-wait — ОТЧЁТ, не отказ (см. consent.ts).
      if (decision.kind === "already_executed") return okExecutionReport(decision.report);
      if (decision.kind === "refused") return ok(decision.result);

      const { payload, auditId } = decision;
      return executeShareCore(g, payload, auditId, consentStore);
    }),
  );

  // ── Unshare ────────────────────────────────────────────────────────────────
  // REAL binding: re-reads each target's LIVE permission list at plan and
  // again at rehash — a concurrent revoke (or the file itself changing)
  // between plan and execute trips the drift check.

  server.registerTool(
    "drive_unshare",
    {
      title: "Remove permissions",
      description:
        "Remove sharing permissions from Drive files or folders. Use drive_get_permissions to find the " +
        "permissionIds. Two-mode consent-gated tool (mcp-development-standard/references/gate.md): call " +
        "WITHOUT `manifest_id`/`user_reply` (with `items`) to build a plan and return a preview — NOBODY loses " +
        "access yet. Show the preview to the user verbatim and wait for their reply. Call again with the " +
        "returned `manifest_id` and the user's VERBATIM `user_reply` to actually revoke.",
      inputSchema: {
        account,
        items: z
          .array(
            z.object({
              fileId: z.string().describe("File or folder ID."),
              permissionId: z.string().describe("Permission ID to remove."),
            }),
          )
          .optional()
          .describe(
            "Required to build a plan (first call, no manifest_id/user_reply). Ignored on the execute call — " +
              "the approved batch is read back from the manifest.",
          ),
        manifest_id: z
          .string()
          .optional()
          .describe("Id of a plan built by a previous no-argument call. Pass together with `user_reply` to execute it."),
        user_reply: z.string().optional().describe(USER_REPLY_DOC),
        automation_key: z.string().optional().describe(AUTOMATION_KEY_DOC),
      },
      annotations: { destructiveHint: true },
    },
    guard(async ({ account, items, manifest_id, user_reply, automation_key }) => {
      const { consentStore, consentCfg, tg, checkAutomationKey } = ctx;
      if (!consentStore) {
        return fail(
          "Отзыв доступа недоступен: не настроено хранилище согласия (DATABASE_URL). Без него сервер не может " +
            "провести это действие через гейт подтверждения — обратитесь к администратору сервера.",
        );
      }
      const g = clients.resolve(account);
      const accountName = account ?? clients.defaultName;

      const decision = await requireConsent<UnsharePayload>({
        tool: "drive_unshare",
        accountLabel: accountName,
        manifestId: manifest_id,
        userReply: user_reply,
        store: consentStore,
        cfg: consentCfg,
        tg,
        automationKey: automation_key,
        checkAutomationKey,
        plan: async () => {
          if (!items || !items.length) {
            throw new Error("Нужен непустой `items`, чтобы построить план отзыва доступа.");
          }
          const snapshot = await shareBindingSnapshot(g, items);
          const payload: UnsharePayload = { account: accountName, items };
          const lines = items.map((it, i) => {
            const cur = snapshot[i];
            const target = cur.permissions.find((p) => p.id === it.permissionId);
            const who = target ? (target.emailAddress ?? target.domain ?? target.type ?? it.permissionId) : it.permissionId;
            return `- **«${safeText(cur.name ?? it.fileId, 60)}»** — отозвать ${safeText(target?.role ?? "?", 20)} у ${safeText(who ?? "", 60)}`;
          });
          const preview = `### 📤 План: Отзыв доступа — ${items.length}\n\n${lines.join("\n")}`;
          const objectHash = sha256({ account: accountName, items, snapshot });
          return { payload, objectHash, preview, batchSize: items.length };
        },
        rehash: (addressing) => unshareRehash(g, addressing),
      });

      if (decision.kind === "planned") return ok(decision.preview);
      // Исполнено другим каналом во время sync-wait — ОТЧЁТ, не отказ (см. consent.ts).
      if (decision.kind === "already_executed") return okExecutionReport(decision.report);
      if (decision.kind === "refused") return ok(decision.result);

      const { payload, auditId } = decision;
      return executeUnshareCore(g, payload, auditId, consentStore);
    }),
  );

  // ── drive_consent_audit ──────────────────────────────────────────────────
  // "Разбор инцидента без ssh" (limits-audit.md §11) — ported from gmail-mcp's
  // gmail_consent_audit / sheets-mcp's sheets_consent_audit. Read-only path
  // over the same consent_audit table the gate writes to; answers "what did
  // the consent gate actually decide" and "did it block anything today"
  // without reading server logs.

  server.registerTool(
    "drive_consent_audit",
    {
      title: "Read the consent-gate audit log",
      description:
        "Read-only log of every decision the consent gate has made for the gated drive_*/docs_*/" +
        "skill_version_update write tools (drive_create_folder/rename/move/trash/upload_file/" +
        "create_upload_session/overwrite_file/share/unshare, docs_create/append_text/insert_text/" +
        "replace_text/raw_batch_update, skill_version_update): plan built, confirmed, refused, or invalidated, " +
        "plus — once the mutation actually ran — its outcome and post-verify result. This is how to answer " +
        "\"what actually happened to that file\" or \"did the gate block anything today\" without reading server " +
        "logs. Filter by `since`/`until` (ISO 8601), `account`, `tool`, or `outcome` " +
        "(confirmed/refused/invalidated/failed — a manifest that's only been planned and never answered has no " +
        "audit row yet, nothing to show). Results are newest first, capped at 100 per page " +
        "(default 20); use `offset` to page through older rows. External text (the verbatim user_reply and the " +
        "outbound pre-snapshot) is shown neutralised, never as live markdown.",
      inputSchema: {
        account: z
          .string()
          .optional()
          .describe("Filter to one account label. Omit to show all accounts, not just the default."),
        since: z.string().optional().describe("ISO 8601 datetime — only rows at or after this time."),
        until: z.string().optional().describe("ISO 8601 datetime — only rows at or before this time."),
        tool: z
          .string()
          .optional()
          .describe("Filter to one tool name, e.g. 'drive_share'. Omit to show every gated tool."),
        outcome: z
          .enum(["confirmed", "refused", "invalidated", "failed"])
          .optional()
          .describe("Filter to one outcome. Omit to show all."),
        limit: z.number().int().min(1).max(100).default(20).optional().describe("Max rows to return (1-100, default 20)."),
        offset: z.number().int().min(0).default(0).optional().describe("Skip this many newest-first rows — for paging past the first `limit`."),
      },
      annotations: { readOnlyHint: true },
    },
    guard(async ({ account, since, until, tool, outcome, limit, offset }) => {
      const { auditStore, consentCfg } = ctx;
      if (!auditStore) {
        return ok({
          summary: "Audit log unavailable — DATABASE_URL is not configured, so nothing has been recorded.",
          results: [],
        });
      }
      const parseWhen = (label: string, s?: string): number | undefined => {
        if (!s) return undefined;
        const t = Date.parse(s);
        if (Number.isNaN(t)) throw new Error(`Cannot parse ${label}="${s}". Use ISO 8601, e.g. 2026-08-04T00:00:00-07:00.`);
        return t;
      };
      const filters = {
        server: consentCfg.server,
        since: parseWhen("since", since),
        until: parseWhen("until", until),
        accountLabel: account?.trim() || undefined,
        tool: tool?.trim() || undefined,
        outcome,
      };
      const cap = limit ?? 20;
      const off = offset ?? 0;
      const [rows, total] = await Promise.all([
        auditStore.listConsentAudit(filters, cap, off),
        auditStore.countConsentAudit(filters),
      ]);

      const outcomeIcon = (o: string): string =>
        o === "confirmed" ? "✅" : o === "failed" ? "❌" : o === "refused" || o === "invalidated" ? "🛑" : "•";

      const header = "| Время (PT) | Инструмент | Аккаунт | Actor | Исход | user_reply | post-verify | Детали |";
      const sep = "|---|---|---|---|---|---|---|---|";
      const lines = rows.map((r) => {
        const details = r.error
          ? `ошибка: ${safeText(r.error, 80)}`
          : r.preSnapshot
            ? `снимок: ${safeText(JSON.stringify(r.preSnapshot), 100)}`
            : "—";
        return (
          `| ${formatLaTime(r.ts)} | ${r.tool} | ${r.accountLabel} | ${r.actor} | ` +
          `${outcomeIcon(r.outcome)} ${r.outcome} | ${safeText(r.userReply, 60) || "—"} | ` +
          `${safeText(r.postVerifyResult ?? "", 60) || "—"} | ${details} |`
        );
      });

      const shownNote =
        total > off + rows.length
          ? `Показано ${rows.length} из ${total} (записи ${off + 1}–${off + rows.length}); ` +
            `есть ещё — вызовите снова с offset=${off + rows.length}.`
          : `Показано ${rows.length} из ${total}.`;

      const body = rows.length ? [header, sep, ...lines].join("\n") : "Нет записей, подходящих под фильтры.";

      return ok(`### 🧾 Журнал согласий\n\n${shownNote}\n\n${body}`);
    }),
  );
}

