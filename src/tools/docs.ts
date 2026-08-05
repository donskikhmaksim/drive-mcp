/**
 * Google Docs tools.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { docs_v1 } from "googleapis";
import { ok, fail, guard, safeText } from "../util.js";
import { accountField, type UserClients } from "../accounts.js";
import type { GoogleClients } from "../google.js";
import {
  requireConsent,
  sha256,
  USER_REPLY_DOC,
  type ConsentStore,
  type ConsentAddressing,
} from "../consent.js";
import {
  type DriveConsentContext,
  DEFAULT_CONSENT_CTX,
  buildMutationResult,
  type VerifyLine,
} from "./drive.js";
import { registerAutoExecutor, type AutoExecutorCtx } from "../autoExecute.js";

/** Flattens a Docs document body into plain text. */
export function documentToPlainText(doc: docs_v1.Schema$Document): string {
  const out: string[] = [];
  const content = doc.body?.content ?? [];
  for (const el of content) {
    const para = el.paragraph;
    if (para?.elements) {
      for (const pe of para.elements) {
        const t = pe.textRun?.content;
        if (t) out.push(t);
      }
    }
    const table = el.table;
    if (table?.tableRows) {
      for (const row of table.tableRows) {
        const cells = (row.tableCells ?? []).map((cell) => {
          const parts: string[] = [];
          for (const cc of cell.content ?? []) {
            for (const pe of cc.paragraph?.elements ?? []) {
              if (pe.textRun?.content) parts.push(pe.textRun.content.trim());
            }
          }
          return parts.join(" ");
        });
        out.push(cells.join("\t") + "\n");
      }
    }
  }
  return out.join("");
}

/** Returns the end index of the document body (where appended text should go). */
function documentEndIndex(doc: docs_v1.Schema$Document): number {
  const content = doc.body?.content ?? [];
  let end = 1;
  for (const el of content) {
    if (typeof el.endIndex === "number") end = el.endIndex;
  }
  // The very last newline of the body is not a valid insertion location;
  // insert just before it.
  return Math.max(1, end - 1);
}

// ── Consent-gate live-read helpers (docs-specific, gate.md §3.3(2)) ─────────
// Same convention as drive.ts: the identical function seeds BOTH the plan-
// time snapshot AND the rehash/post-verify read, so the binding is a real
// drift check, not `sha256(payload)` in disguise.

/** Live document title, or null if unreadable (deleted/no access). */
async function liveDocTitle(g: GoogleClients, documentId: string): Promise<string | null> {
  try {
    const res = await g.docs.documents.get({ documentId, fields: "title" });
    return res.data.title ?? null;
  } catch {
    return null;
  }
}

/** Live plain-text body of a document, or null if unreadable. */
async function liveDocText(g: GoogleClients, documentId: string): Promise<string | null> {
  try {
    const res = await g.docs.documents.get({ documentId });
    return documentToPlainText(res.data);
  } catch {
    return null;
  }
}

/** Post-verify: the document still exists and (when a title was known) still
 * carries it — identity confirmation for a mutation that targeted it. */
async function postVerifyDocIdentity(g: GoogleClients, documentId: string, label: string): Promise<VerifyLine> {
  const title = await liveDocTitle(g, documentId);
  const lbl = safeText(label) || "(документ)";
  if (title === null) {
    return { outcome: "warn", line: `- ⚠️ **«${lbl}»** — не удалось перепроверить документ ${safeText(documentId)}` };
  }
  return { outcome: "ok", line: `- ✅ **«${safeText(title) || lbl}»** — документ существует` };
}

/** Post-verify: live body now contains `needle` (append/insert landed). */
async function postVerifyTextContains(
  g: GoogleClients,
  documentId: string,
  needle: string,
  label: string,
): Promise<VerifyLine> {
  const text = await liveDocText(g, documentId);
  const lbl = safeText(label) || "(документ)";
  if (text === null) {
    return { outcome: "warn", line: `- ⚠️ **«${lbl}»** — не удалось перепроверить документ ${safeText(documentId)}` };
  }
  if (!needle || text.includes(needle)) {
    return { outcome: "ok", line: `- ✅ **«${lbl}»** — текст найден в живом документе` };
  }
  return { outcome: "mismatch", line: `- ❌ **«${lbl}»** — текста НЕТ в живом документе` };
}

/** Post-verify for docs_replace_text: live body no longer contains `find`
 * (or `find`==`replace`, a no-op the API itself would report as 0 occurrences). */
async function postVerifyReplaced(
  g: GoogleClients,
  documentId: string,
  find: string,
  replaceText: string,
  label: string,
): Promise<VerifyLine> {
  const text = await liveDocText(g, documentId);
  const lbl = safeText(label) || "(документ)";
  if (text === null) {
    return { outcome: "warn", line: `- ⚠️ **«${lbl}»** — не удалось перепроверить документ ${safeText(documentId)}` };
  }
  if (find === replaceText || !text.includes(find)) {
    return { outcome: "ok", line: `- ✅ **«${lbl}»** — замена подтверждена (искомого текста в живом документе больше нет)` };
  }
  return { outcome: "mismatch", line: `- ❌ **«${lbl}»** — искомый текст всё ещё есть в живом документе` };
}

/** Post-verify for docs_raw_batch_update: honest limit (STANDARD §15.1 Q20,
 * same convention as sheets-mcp's raw_batch_update) — content-level
 * verification of an ARBITRARY batchUpdate request is not generically
 * possible. Only confirms the document is still reachable after the call. */
async function postVerifyRawBatchApplied(g: GoogleClients, documentId: string): Promise<VerifyLine> {
  const title = await liveDocTitle(g, documentId);
  if (title === null) {
    return { outcome: "warn", line: `- ⚠️ **(${safeText(documentId)})** — документ недоступен после применения` };
  }
  return {
    outcome: "warn",
    line: `- ⚠️ **«${safeText(title)}»** — запрос применён без ошибки; произвольный batchUpdate нельзя обобщённо перепроверить по содержимому (честный предел, см. GUIDE.md)`,
  };
}

// ── Payload shapes for the 5 gated write tools ───────────────────────────────
// Lifted to module scope (were previously declared inside registerDocsTools)
// so the extracted `executeXxxCore`/`rehashXxx` functions below — used BOTH
// by the normal MCP tool handler and by `registerAutoExecutor` (auto-execute
// on a Telegram-button click, see autoExecute.ts's doc-comment) — can
// reference them.

interface CreateDocPayload {
  account: string;
  title: string;
  text?: string;
}

interface AppendTextPayload {
  account: string;
  documentId: string;
  text: string;
}

interface InsertTextPayload {
  account: string;
  documentId: string;
  index: number;
  text: string;
}

interface ReplaceTextPayload {
  account: string;
  documentId: string;
  find: string;
  replace: string;
  matchCase: boolean;
}

interface RawBatchUpdatePayload {
  account: string;
  documentId: string;
  requests: Record<string, unknown>[];
}

// ── UserClients tracker for the auto-execute path ────────────────────────────
// `registerAutoExecutor(...)` below is called at MODULE scope (import time,
// per autoExecute.ts's doc-comment — must NOT live inside `registerDocsTools`,
// which re-runs per MCP session). Its `execute` gets a fresh `UserClients` via
// `AutoExecutorCtx` (the poller builds one per tick, see http.ts's
// `runAutoExecutePoller`), but `rehash` does NOT — `RehashFn` is
// `(addressing) => string | Promise<string>`, a single argument, because
// `tryAutoExecute()` in consent.ts calls it directly with no ctx (see its
// call site in http.ts). `docs_create`'s rehash is degenerate (no live read,
// same reasoning as gmail_send — see below) so it doesn't need this. The other
// 4 tools' rehash DOES need a live `g.docs.documents.get(...)` read (gate.md
// §3.3(2) REAL binding, unchanged from before this refactor) — for that it
// needs *some* `UserClients` to resolve an account into a `GoogleClients`.
//
// Solution: `registerDocsTools` (called at least once, by `server.ts`'s
// `buildMcpServer`, before any tool call can exist — and therefore before any
// consent manifest the poller could ever pick up) stashes the `UserClients`
// it was given here. The auto-execute rehash functions reuse it. This is the
// same underlying OAuth-backed `GoogleClients` the interactive path uses, not
// a re-derivation — cheap and correct for this server's single-tenant-per-
// process deployment model (mirrors the poller's own `config.users[0]`
// fallback in http.ts).
let lastClients: UserClients | undefined;

function requireLastClients(): UserClients {
  if (!lastClients) {
    throw new Error(
      "docs: авто-исполнение вызвано раньше первой регистрации инструментов (registerDocsTools ни разу не " +
        "вызывался в этом процессе) — нет UserClients, чтобы перечитать живое состояние документа.",
    );
  }
  return lastClients;
}

// ── Shared rehash functions (gate.md §3.3(2) binding) ────────────────────────
// Each is used BOTH as the `rehash` passed to `requireConsent()` in the
// tool body (closure over the request's own `clients`) AND as the `rehash`
// registered with `registerAutoExecutor()` (closure over `requireLastClients()`)
// — literally the same function, just handed a different `UserClients`. This
// is what keeps the auto-execute path's binding check exactly as strong as
// the interactive path's (mcp-development-standard requirement).

/** Degenerate binding (gate.md §3.3(2) honest exception, same as
 * drive_create_folder/gmail_send): a document that doesn't exist yet has no
 * live object to bind against, so objectHash = sha256(payload) on both sides. */
function rehashCreateDoc(addressing: ConsentAddressing): string {
  return sha256(addressing as CreateDocPayload);
}

/** REAL binding: re-reads the document's LIVE end-index — a concurrent edit
 * that shifts the body length between plan and execute trips the drift check. */
async function rehashAppendText(clients: UserClients, addressing: ConsentAddressing): Promise<string> {
  const a = addressing as AppendTextPayload;
  const g = clients.resolve(a.account);
  const doc = await g.docs.documents.get({ documentId: a.documentId }).catch(() => null);
  const endIndex = doc ? documentEndIndex(doc.data) : null;
  return sha256({ account: a.account, documentId: a.documentId, text: a.text, endIndex });
}

/** REAL binding: re-reads the document's LIVE length/end-index — a concurrent
 * edit changes the snapshot and trips drift. */
async function rehashInsertText(clients: UserClients, addressing: ConsentAddressing): Promise<string> {
  const a = addressing as InsertTextPayload;
  const g = clients.resolve(a.account);
  const doc = await g.docs.documents.get({ documentId: a.documentId }).catch(() => null);
  const liveEnd = doc ? documentEndIndex(doc.data) : null;
  return sha256({ account: a.account, documentId: a.documentId, index: a.index, text: a.text, liveEnd });
}

/** REAL binding: a live dry-count of `find` occurrences — a concurrent edit
 * that changes the occurrence count trips the drift check. */
async function rehashReplaceText(clients: UserClients, addressing: ConsentAddressing): Promise<string> {
  const a = addressing as ReplaceTextPayload;
  const g = clients.resolve(a.account);
  const text = await liveDocText(g, a.documentId);
  const count = text ? text.split(a.find).length - 1 : 0;
  return sha256({
    account: a.account,
    documentId: a.documentId,
    find: a.find,
    replace: a.replace,
    matchCase: a.matchCase,
    count,
  });
}

/** Degenerate-ish binding: an arbitrary batchUpdate request has no generic
 * way to predict what it will touch ahead of time, so binding is on the
 * document's live title + the exact requests (a rename/delete of the
 * document between plan and execute still trips drift via the title check). */
async function rehashRawBatchUpdate(clients: UserClients, addressing: ConsentAddressing): Promise<string> {
  const a = addressing as RawBatchUpdatePayload;
  const g = clients.resolve(a.account);
  const title = await liveDocTitle(g, a.documentId);
  return sha256({ account: a.account, documentId: a.documentId, requests: a.requests, title });
}

// ── Execution cores (auto-execution package, Максим 2026-08-05) ─────────────
// Extracted from each tool's body (the code that used to run after the
// `decision.kind === "planned"/"refused"` early returns) so it can be called
// BOTH from the normal MCP tool handler (model calls execute a second time)
// AND from the background auto-execute poller (Telegram button triggers this
// directly, with no model involved at all — see autoExecute.ts's doc-comment
// on why this is a plain function, not an MCP tool parameter). No behaviour
// changed — pure extract-function refactor.

async function executeCreateDocCore(
  g: GoogleClients,
  payload: CreateDocPayload,
  auditId: string,
  consentStore: ConsentStore,
): Promise<CallToolResult> {
  let created: { documentId: string; title: string | null; error?: string };
  try {
    const res = await g.docs.documents.create({ requestBody: { title: payload.title } });
    const documentId = res.data.documentId!;
    if (payload.text) {
      await g.docs.documents.batchUpdate({
        documentId,
        requestBody: { requests: [{ insertText: { location: { index: 1 }, text: payload.text } }] },
      });
    }
    created = { documentId, title: res.data.title ?? payload.title };
  } catch (e: unknown) {
    created = { documentId: "", title: null, error: e instanceof Error ? e.message : String(e) };
  }
  return buildMutationResult({
    results: [created],
    total: 1,
    verb: "Created",
    summaryIcon: "📄",
    verify: (r) => postVerifyDocIdentity(g, r.documentId, r.title ?? payload.title),
    reportTitle: "Независимая проверка создания документа",
    reportSubtitle: "запрошено ⇄ живые документы Docs",
    consentStore,
    auditId,
  });
}

async function executeAppendTextCore(
  g: GoogleClients,
  payload: AppendTextPayload,
  auditId: string,
  consentStore: ConsentStore,
): Promise<CallToolResult> {
  let result: { documentId: string; title: string | null; error?: string };
  try {
    const doc = await g.docs.documents.get({ documentId: payload.documentId });
    const index = documentEndIndex(doc.data);
    await g.docs.documents.batchUpdate({
      documentId: payload.documentId,
      requestBody: { requests: [{ insertText: { location: { index }, text: payload.text } }] },
    });
    result = { documentId: payload.documentId, title: doc.data.title ?? null };
  } catch (e: unknown) {
    result = { documentId: payload.documentId, title: null, error: e instanceof Error ? e.message : String(e) };
  }
  return buildMutationResult({
    results: [result],
    total: 1,
    verb: "Appended",
    summaryIcon: "📝",
    verify: (r) => postVerifyTextContains(g, r.documentId, payload.text, r.title ?? r.documentId),
    reportTitle: "Независимая проверка добавления текста",
    reportSubtitle: "запрошено ⇄ живой текст документа",
    consentStore,
    auditId,
  });
}

async function executeInsertTextCore(
  g: GoogleClients,
  payload: InsertTextPayload,
  auditId: string,
  consentStore: ConsentStore,
): Promise<CallToolResult> {
  let result: { documentId: string; title: string | null; error?: string };
  try {
    let docTitle: string | null = null;
    try {
      const meta = await g.docs.documents.get({ documentId: payload.documentId });
      docTitle = meta.data.title ?? null;
    } catch {}
    await g.docs.documents.batchUpdate({
      documentId: payload.documentId,
      requestBody: { requests: [{ insertText: { location: { index: payload.index }, text: payload.text } }] },
    });
    result = { documentId: payload.documentId, title: docTitle };
  } catch (e: unknown) {
    result = { documentId: payload.documentId, title: null, error: e instanceof Error ? e.message : String(e) };
  }
  return buildMutationResult({
    results: [result],
    total: 1,
    verb: "Inserted",
    summaryIcon: "📝",
    verify: (r) => postVerifyTextContains(g, r.documentId, payload.text, r.title ?? r.documentId),
    reportTitle: "Независимая проверка вставки текста",
    reportSubtitle: "запрошено ⇄ живой текст документа",
    consentStore,
    auditId,
  });
}

async function executeReplaceTextCore(
  g: GoogleClients,
  payload: ReplaceTextPayload,
  auditId: string,
  consentStore: ConsentStore,
): Promise<CallToolResult> {
  let result: { documentId: string; title: string | null; occurrencesChanged: number; error?: string };
  try {
    let docTitle: string | null = null;
    try {
      const meta = await g.docs.documents.get({ documentId: payload.documentId });
      docTitle = meta.data.title ?? null;
    } catch {}
    const res = await g.docs.documents.batchUpdate({
      documentId: payload.documentId,
      requestBody: {
        requests: [
          {
            replaceAllText: {
              containsText: { text: payload.find, matchCase: payload.matchCase },
              replaceText: payload.replace,
            },
          },
        ],
      },
    });
    const occurrencesChanged = res.data.replies?.[0]?.replaceAllText?.occurrencesChanged ?? 0;
    result = { documentId: payload.documentId, title: docTitle, occurrencesChanged };
  } catch (e: unknown) {
    result = {
      documentId: payload.documentId,
      title: null,
      occurrencesChanged: 0,
      error: e instanceof Error ? e.message : String(e),
    };
  }
  return buildMutationResult({
    results: [result],
    total: 1,
    verb: "Replaced",
    summaryIcon: "🔄",
    verify: (r) => postVerifyReplaced(g, r.documentId, payload.find, payload.replace, r.title ?? r.documentId),
    reportTitle: "Независимая проверка замены текста",
    reportSubtitle: "запрошено ⇄ живой текст документа",
    consentStore,
    auditId,
  });
}

async function executeRawBatchUpdateCore(
  g: GoogleClients,
  payload: RawBatchUpdatePayload,
  auditId: string,
  consentStore: ConsentStore,
): Promise<CallToolResult> {
  let result: { documentId: string; replies?: unknown; error?: string };
  try {
    const res = await g.docs.documents.batchUpdate({
      documentId: payload.documentId,
      requestBody: { requests: payload.requests as object[] },
    });
    result = { documentId: res.data.documentId ?? payload.documentId, replies: res.data.replies };
  } catch (e: unknown) {
    result = { documentId: payload.documentId, error: e instanceof Error ? e.message : String(e) };
  }
  return buildMutationResult({
    results: [result],
    total: 1,
    verb: "Applied",
    summaryIcon: "⚙️",
    verify: (r) => postVerifyRawBatchApplied(g, r.documentId),
    reportTitle: "Независимая проверка raw batchUpdate",
    reportSubtitle: "честный предел: содержимое обобщённо не проверяется",
    consentStore,
    auditId,
  });
}

/** Extracts the human-readable text from a CallToolResult — the same text the
 * model would have seen in chat, used for the Telegram auto-execution report
 * (see autoExecute.ts's `ExecuteFn` doc-comment). If a tool's success payload
 * carries a link (e.g. docs_create's webViewLink), it lives inside this text
 * because `util.ts`'s `ok()` JSON.stringifies non-string data into it. */
function extractText(result: CallToolResult): string {
  const first = result.content?.[0];
  return first && first.type === "text" ? first.text : JSON.stringify(result);
}

// ── Auto-execute registrations (module scope — see doc-comment on
// `lastClients` above for why this must NOT move inside registerDocsTools) ──

registerAutoExecutor("docs_create", {
  rehash: rehashCreateDoc,
  execute: async (payload, auditId, ctx: AutoExecutorCtx) => {
    const p = payload as CreateDocPayload;
    const g = ctx.clients.resolve(p.account);
    const result = await executeCreateDocCore(g, p, auditId, ctx.consentStore);
    return extractText(result);
  },
});

registerAutoExecutor("docs_append_text", {
  rehash: (addressing) => rehashAppendText(requireLastClients(), addressing),
  execute: async (payload, auditId, ctx: AutoExecutorCtx) => {
    const p = payload as AppendTextPayload;
    const g = ctx.clients.resolve(p.account);
    const result = await executeAppendTextCore(g, p, auditId, ctx.consentStore);
    return extractText(result);
  },
});

registerAutoExecutor("docs_insert_text", {
  rehash: (addressing) => rehashInsertText(requireLastClients(), addressing),
  execute: async (payload, auditId, ctx: AutoExecutorCtx) => {
    const p = payload as InsertTextPayload;
    const g = ctx.clients.resolve(p.account);
    const result = await executeInsertTextCore(g, p, auditId, ctx.consentStore);
    return extractText(result);
  },
});

registerAutoExecutor("docs_replace_text", {
  rehash: (addressing) => rehashReplaceText(requireLastClients(), addressing),
  execute: async (payload, auditId, ctx: AutoExecutorCtx) => {
    const p = payload as ReplaceTextPayload;
    const g = ctx.clients.resolve(p.account);
    const result = await executeReplaceTextCore(g, p, auditId, ctx.consentStore);
    return extractText(result);
  },
});

registerAutoExecutor("docs_raw_batch_update", {
  rehash: (addressing) => rehashRawBatchUpdate(requireLastClients(), addressing),
  execute: async (payload, auditId, ctx: AutoExecutorCtx) => {
    const p = payload as RawBatchUpdatePayload;
    const g = ctx.clients.resolve(p.account);
    const result = await executeRawBatchUpdateCore(g, p, auditId, ctx.consentStore);
    return extractText(result);
  },
});

export function registerDocsTools(server: McpServer, clients: UserClients, ctx: DriveConsentContext = DEFAULT_CONSENT_CTX) {
  lastClients = clients;
  const account = accountField(clients);

  server.registerTool(
    "docs_list",
    {
      title: "List documents",
      description:
        "List Google Docs the account can access. Optionally filter by a name substring.",
      inputSchema: {
        account,
        nameContains: z.string().optional(),
        maxResults: z.number().int().min(1).max(200).default(50).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    guard(async ({ account, nameContains, maxResults }) => {
      const g = clients.resolve(account);
      const qParts = [
        "mimeType='application/vnd.google-apps.document'",
        "trashed=false",
      ];
      if (nameContains) {
        qParts.push(`name contains '${nameContains.replace(/'/g, "\\'")}'`);
      }
      const res = await g.drive.files.list({
        q: qParts.join(" and "),
        pageSize: maxResults ?? 50,
        fields: "files(id,name,modifiedTime,webViewLink)",
        orderBy: "modifiedTime desc",
      });
      const files = res.data.files ?? [];
      return ok({
        summary: `📋 ${files.length} document(s)${nameContains ? ` matching "${nameContains}"` : ""} on account "${account ?? "default"}"`,
        files,
      });
    }),
  );

  server.registerTool(
    "docs_read",
    {
      title: "Read document",
      description:
        "Read a Google Doc as plain text. Set `raw` to true to get the full structural JSON instead.",
      inputSchema: {
        account,
        documentId: z.string(),
        raw: z.boolean().default(false).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    guard(async ({ account, documentId, raw }) => {
      const g = clients.resolve(account);
      const res = await g.docs.documents.get({ documentId });
      if (raw) return ok(res.data);
      const text = documentToPlainText(res.data);
      return ok({
        summary: `📖 Read "${res.data.title ?? documentId}" — ${text.length} char(s)`,
        title: res.data.title,
        documentId: res.data.documentId,
        text,
      });
    }),
  );

  // ── Create ─────────────────────────────────────────────────────────────────
  // Two-mode consent-gated tool. Degenerate binding (gate.md §3.3(2) honest
  // exception, same as drive_create_folder): a document that doesn't exist
  // yet has no live object to bind against, so objectHash = sha256(payload)
  // on BOTH sides. Post-verify is still real: re-fetches the created document.

  server.registerTool(
    "docs_create",
    {
      title: "Create document",
      description:
        "Create a new Google Doc, optionally with initial text. Returns its id. Two-mode consent-gated tool " +
        "(mcp-development-standard/references/gate.md): call WITHOUT `manifest_id`/`user_reply` (with `title`) " +
        "to build a plan and return a preview — NOTHING is created yet. Show the preview to the user verbatim " +
        "and wait for their reply. Call again with the returned `manifest_id` and the user's VERBATIM " +
        "`user_reply` to actually create.",
      inputSchema: {
        account,
        title: z.string().optional().describe("Required to build a plan (first call). Ignored on the execute call."),
        text: z.string().optional().describe("Optional initial body text."),
        manifest_id: z
          .string()
          .optional()
          .describe("Id of a plan built by a previous no-argument call. Pass together with `user_reply` to execute it."),
        user_reply: z.string().optional().describe(USER_REPLY_DOC),
      },
      annotations: { destructiveHint: false },
    },
    guard(async ({ account, title, text, manifest_id, user_reply }) => {
      const { consentStore, consentCfg, tg } = ctx;
      if (!consentStore) {
        return fail(
          "Создание документа недоступно: не настроено хранилище согласия (DATABASE_URL). Без него сервер не " +
            "может провести это действие через гейт подтверждения — обратитесь к администратору сервера.",
        );
      }
      const g = clients.resolve(account);
      const accountName = account ?? clients.defaultName;

      const decision = await requireConsent<CreateDocPayload>({
        tool: "docs_create",
        accountLabel: accountName,
        manifestId: manifest_id,
        userReply: user_reply,
        store: consentStore,
        cfg: consentCfg,
        tg,
        plan: async () => {
          if (!title) {
            throw new Error("Нужен `title`, чтобы построить план создания документа.");
          }
          const payload: CreateDocPayload = { account: accountName, title, text };
          const preview =
            `### 📤 План: Создание документа\n\n- **«${safeText(title, 100)}»**` +
            (text ? ` (${text.length} симв. начального текста)` : " (пустой)");
          const objectHash = sha256(payload);
          return { payload, objectHash, preview };
        },
        rehash: rehashCreateDoc,
      });

      if (decision.kind === "planned") return ok(decision.preview);
      if (decision.kind === "refused") return ok(decision.result);

      const { payload, auditId } = decision;
      return executeCreateDocCore(g, payload, auditId, consentStore);
    }),
  );

  // ── Append text ───────────────────────────────────────────────────────────
  // REAL binding: re-reads the document's LIVE end-index at plan and again at
  // rehash — a concurrent edit that shifts the body length between plan and
  // execute trips the drift check.

  server.registerTool(
    "docs_append_text",
    {
      title: "Append text",
      description:
        "Append text to the end of a document. Two-mode consent-gated tool " +
        "(mcp-development-standard/references/gate.md): call WITHOUT `manifest_id`/`user_reply` (with " +
        "`documentId`/`text`) to build a plan and return a preview — NOTHING is appended yet. Show the preview " +
        "to the user verbatim and wait for their reply. Call again with the returned `manifest_id` and the " +
        "user's VERBATIM `user_reply` to actually append.",
      inputSchema: {
        account,
        documentId: z.string().optional().describe("Required to build a plan (first call). Ignored on the execute call."),
        text: z.string().optional().describe("Required to build a plan (first call). Ignored on the execute call."),
        manifest_id: z
          .string()
          .optional()
          .describe("Id of a plan built by a previous no-argument call. Pass together with `user_reply` to execute it."),
        user_reply: z.string().optional().describe(USER_REPLY_DOC),
      },
    },
    guard(async ({ account, documentId, text, manifest_id, user_reply }) => {
      const { consentStore, consentCfg, tg } = ctx;
      if (!consentStore) {
        return fail(
          "Добавление текста недоступно: не настроено хранилище согласия (DATABASE_URL). Без него сервер не " +
            "может провести это действие через гейт подтверждения — обратитесь к администратору сервера.",
        );
      }
      const g = clients.resolve(account);
      const accountName = account ?? clients.defaultName;

      const decision = await requireConsent<AppendTextPayload>({
        tool: "docs_append_text",
        accountLabel: accountName,
        manifestId: manifest_id,
        userReply: user_reply,
        store: consentStore,
        cfg: consentCfg,
        tg,
        plan: async () => {
          if (!documentId || text === undefined) {
            throw new Error("Нужны `documentId` и `text`, чтобы построить план добавления текста.");
          }
          const doc = await g.docs.documents.get({ documentId }).catch(() => null);
          const endIndex = doc ? documentEndIndex(doc.data) : null;
          const title = doc?.data.title ?? null;
          const payload: AppendTextPayload = { account: accountName, documentId, text };
          const preview =
            `### 📤 План: Добавление текста\n\n- **«${safeText(title ?? documentId, 80)}»** — добавить ${text.length} симв.: ` +
            `«${safeText(text, 120)}»`;
          const objectHash = sha256({ account: accountName, documentId, text, endIndex });
          return { payload, objectHash, preview };
        },
        rehash: (addressing) => rehashAppendText(clients, addressing),
      });

      if (decision.kind === "planned") return ok(decision.preview);
      if (decision.kind === "refused") return ok(decision.result);

      const { payload, auditId } = decision;
      return executeAppendTextCore(g, payload, auditId, consentStore);
    }),
  );

  // ── Insert at index ───────────────────────────────────────────────────────
  // REAL binding: re-reads the document's LIVE length/end-index at plan and
  // again at rehash — a concurrent edit changes the snapshot and trips drift.

  server.registerTool(
    "docs_insert_text",
    {
      title: "Insert text at index",
      description:
        "Insert text at a specific character index (1 = very start of the body). Two-mode consent-gated tool " +
        "(mcp-development-standard/references/gate.md): call WITHOUT `manifest_id`/`user_reply` (with " +
        "`documentId`/`index`/`text`) to build a plan and return a preview — NOTHING is inserted yet. Show the " +
        "preview to the user verbatim and wait for their reply. Call again with the returned `manifest_id` and " +
        "the user's VERBATIM `user_reply` to actually insert.",
      inputSchema: {
        account,
        documentId: z.string().optional().describe("Required to build a plan (first call). Ignored on the execute call."),
        index: z.number().int().min(1).optional().describe("Required to build a plan (first call). Ignored on the execute call."),
        text: z.string().optional().describe("Required to build a plan (first call). Ignored on the execute call."),
        manifest_id: z
          .string()
          .optional()
          .describe("Id of a plan built by a previous no-argument call. Pass together with `user_reply` to execute it."),
        user_reply: z.string().optional().describe(USER_REPLY_DOC),
      },
    },
    guard(async ({ account, documentId, index, text, manifest_id, user_reply }) => {
      const { consentStore, consentCfg, tg } = ctx;
      if (!consentStore) {
        return fail(
          "Вставка текста недоступна: не настроено хранилище согласия (DATABASE_URL). Без него сервер не может " +
            "провести это действие через гейт подтверждения — обратитесь к администратору сервера.",
        );
      }
      const g = clients.resolve(account);
      const accountName = account ?? clients.defaultName;

      const decision = await requireConsent<InsertTextPayload>({
        tool: "docs_insert_text",
        accountLabel: accountName,
        manifestId: manifest_id,
        userReply: user_reply,
        store: consentStore,
        cfg: consentCfg,
        tg,
        plan: async () => {
          if (!documentId || index === undefined || text === undefined) {
            throw new Error("Нужны `documentId`, `index` и `text`, чтобы построить план вставки.");
          }
          const doc = await g.docs.documents.get({ documentId }).catch(() => null);
          const liveEnd = doc ? documentEndIndex(doc.data) : null;
          const title = doc?.data.title ?? null;
          const payload: InsertTextPayload = { account: accountName, documentId, index, text };
          const preview =
            `### 📤 План: Вставка текста\n\n- **«${safeText(title ?? documentId, 80)}»** — вставить в индекс ${index}: ` +
            `«${safeText(text, 120)}»`;
          const objectHash = sha256({ account: accountName, documentId, index, text, liveEnd });
          return { payload, objectHash, preview };
        },
        rehash: (addressing) => rehashInsertText(clients, addressing),
      });

      if (decision.kind === "planned") return ok(decision.preview);
      if (decision.kind === "refused") return ok(decision.result);

      const { payload, auditId } = decision;
      return executeInsertTextCore(g, payload, auditId, consentStore);
    }),
  );

  // ── Replace text ──────────────────────────────────────────────────────────
  // REAL binding: a live dry-count of `find` occurrences, re-read at plan and
  // again at rehash — a concurrent edit that changes the occurrence count
  // trips the drift check.

  server.registerTool(
    "docs_replace_text",
    {
      title: "Replace all text",
      description:
        "Find and replace all occurrences of a string in a document. Two-mode consent-gated tool " +
        "(mcp-development-standard/references/gate.md): call WITHOUT `manifest_id`/`user_reply` (with " +
        "`documentId`/`find`/`replace`) to build a plan and return a preview — NOTHING is replaced yet. Show " +
        "the preview to the user verbatim and wait for their reply. Call again with the returned `manifest_id` " +
        "and the user's VERBATIM `user_reply` to actually replace.",
      inputSchema: {
        account,
        documentId: z.string().optional().describe("Required to build a plan (first call). Ignored on the execute call."),
        find: z.string().optional().describe("Required to build a plan (first call). Ignored on the execute call."),
        replace: z.string().optional().describe("Required to build a plan (first call). Ignored on the execute call."),
        matchCase: z.boolean().default(false).optional(),
        manifest_id: z
          .string()
          .optional()
          .describe("Id of a plan built by a previous no-argument call. Pass together with `user_reply` to execute it."),
        user_reply: z.string().optional().describe(USER_REPLY_DOC),
      },
      annotations: { destructiveHint: true },
    },
    guard(async ({ account, documentId, find, replace, matchCase, manifest_id, user_reply }) => {
      const { consentStore, consentCfg, tg } = ctx;
      if (!consentStore) {
        return fail(
          "Замена текста недоступна: не настроено хранилище согласия (DATABASE_URL). Без него сервер не может " +
            "провести это действие через гейт подтверждения — обратитесь к администратору сервера.",
        );
      }
      const g = clients.resolve(account);
      const accountName = account ?? clients.defaultName;
      const mc = matchCase ?? false;

      const decision = await requireConsent<ReplaceTextPayload>({
        tool: "docs_replace_text",
        accountLabel: accountName,
        manifestId: manifest_id,
        userReply: user_reply,
        store: consentStore,
        cfg: consentCfg,
        tg,
        plan: async () => {
          if (!documentId || find === undefined || replace === undefined) {
            throw new Error("Нужны `documentId`, `find` и `replace`, чтобы построить план замены.");
          }
          const text = await liveDocText(g, documentId);
          const title = await liveDocTitle(g, documentId);
          const count = text ? text.split(find).length - 1 : 0;
          const payload: ReplaceTextPayload = { account: accountName, documentId, find, replace, matchCase: mc };
          const preview =
            `### 📤 План: Замена текста\n\n- **«${safeText(title ?? documentId, 80)}»** — «${safeText(find, 60)}» → ` +
            `«${safeText(replace, 60)}» (сейчас ~${count} вхожд.)`;
          const objectHash = sha256({ account: accountName, documentId, find, replace, matchCase: mc, count });
          return { payload, objectHash, preview };
        },
        rehash: (addressing) => rehashReplaceText(clients, addressing),
      });

      if (decision.kind === "planned") return ok(decision.preview);
      if (decision.kind === "refused") return ok(decision.result);

      const { payload, auditId } = decision;
      return executeReplaceTextCore(g, payload, auditId, consentStore);
    }),
  );

  // ── Raw batchUpdate (advanced) ────────────────────────────────────────────
  // Degenerate-ish binding: an arbitrary batchUpdate request has no generic
  // way to predict what it will touch ahead of time, so binding is on the
  // document's live title + the exact requests (a rename/delete of the
  // document between plan and execute still trips drift via the title
  // check). Post-verify is an HONEST LIMIT (see postVerifyRawBatchApplied).

  server.registerTool(
    "docs_raw_batch_update",
    {
      title: "Raw Docs batchUpdate (advanced)",
      description:
        "Send raw Docs API batchUpdate `requests` (styling, tables, images, etc.). Use only when other tools " +
        "are not enough. Two-mode consent-gated tool (mcp-development-standard/references/gate.md): call " +
        "WITHOUT `manifest_id`/`user_reply` (with `documentId`/`requests`) to build a plan and return a preview " +
        "— NOTHING is applied yet. Show the preview to the user verbatim and wait for their reply. Call again " +
        "with the returned `manifest_id` and the user's VERBATIM `user_reply` to actually apply.",
      inputSchema: {
        account,
        documentId: z.string().optional().describe("Required to build a plan (first call). Ignored on the execute call."),
        requests: z
          .array(z.record(z.string(), z.any()))
          .optional()
          .describe("Required to build a plan (first call). Ignored on the execute call."),
        manifest_id: z
          .string()
          .optional()
          .describe("Id of a plan built by a previous no-argument call. Pass together with `user_reply` to execute it."),
        user_reply: z.string().optional().describe(USER_REPLY_DOC),
      },
      annotations: { destructiveHint: true },
    },
    guard(async ({ account, documentId, requests, manifest_id, user_reply }) => {
      const { consentStore, consentCfg, tg } = ctx;
      if (!consentStore) {
        return fail(
          "Применение raw batchUpdate недоступно: не настроено хранилище согласия (DATABASE_URL). Без него " +
            "сервер не может провести это действие через гейт подтверждения — обратитесь к администратору сервера.",
        );
      }
      const g = clients.resolve(account);
      const accountName = account ?? clients.defaultName;

      const decision = await requireConsent<RawBatchUpdatePayload>({
        tool: "docs_raw_batch_update",
        accountLabel: accountName,
        manifestId: manifest_id,
        userReply: user_reply,
        store: consentStore,
        cfg: consentCfg,
        tg,
        plan: async () => {
          if (!documentId || !requests || !requests.length) {
            throw new Error("Нужны `documentId` и непустой `requests`, чтобы построить план.");
          }
          const title = await liveDocTitle(g, documentId);
          const payload: RawBatchUpdatePayload = { account: accountName, documentId, requests };
          const preview =
            `### 📤 План: Raw batchUpdate — ${requests.length} запрос(ов)\n\n- **«${safeText(title ?? documentId, 80)}»** — ` +
            `${requests.map((r) => safeText(Object.keys(r)[0] ?? "?", 30)).join(", ")}`;
          const objectHash = sha256({ account: accountName, documentId, requests, title });
          return { payload, objectHash, preview };
        },
        rehash: (addressing) => rehashRawBatchUpdate(clients, addressing),
      });

      if (decision.kind === "planned") return ok(decision.preview);
      if (decision.kind === "refused") return ok(decision.result);

      const { payload, auditId } = decision;
      return executeRawBatchUpdateCore(g, payload, auditId, consentStore);
    }),
  );
}
