#!/usr/bin/env node
/**
 * Reflexive gate-coverage test (ported from gmail-mcp's / sheets-mcp's
 * scripts/test-gate-coverage.mjs — mcp-development-standard
 * `references/development-pipeline.md`, T2 checklist item 4).
 *
 * Does NOT hand-pick which tools to exercise. It lists the tools from the
 * REAL registered MCP registry (`client.listTools()`, i.e. what a model
 * actually sees) and, for every tool classified as a write (no
 * `readOnlyHint: true` — the exact rule the task specifies), checks it
 * against an explicit allowlist:
 *
 *  - every entry in `GATED_TOOLS` gets a real BEHAVIOURAL check: calling it
 *    WITHOUT manifest_id/user_reply must not reach ANY mutating fake API
 *    call, and the response must look like a plan, not a success header;
 *  - everything else that is a write MUST be named in
 *    `UNGATED_WRITE_ALLOWLIST` below, with a one-line reason.
 *
 * Per Maksim's standing decision (2026-08-04, "гейт у ВСЕХ write, без
 * исключений") this repo's allowlist has exactly ONE entry: drive_extract_text
 * — it is functionally a read (OCR text extraction) whose internal
 * files.copy+files.delete targets only an ephemeral, server-named temp file
 * that is created and destroyed within the same call, never left behind or
 * exposed to the user; nothing persisted needs a human's consent. It carries
 * readOnlyHint:true in the registry (see src/tools/drive.ts), so in practice
 * it is classified as a READ below and this allowlist entry never fires —
 * kept only so a future accidental removal of that annotation fails loudly
 * here instead of shipping silently ungated.
 *
 * Usage: node scripts/test-gate-coverage.mjs
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerDriveTools } from "../dist/tools/drive.js";
import { registerDocsTools } from "../dist/tools/docs.js";
import { registerSkillVersionTools } from "../dist/tools/skill_version.js";
import { registerAccountTools } from "../dist/accounts.js";

let failures = 0;
const check = (label, cond, extra = "") => {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${label}${cond ? "" : ` — got: ${extra}`}`);
  if (!cond) failures++;
};
const text = (r) => r.content[0].text;

const UNGATED_WRITE_ALLOWLIST = {
  drive_extract_text: "ephemeral internal temp-file copy+delete, no persisted external mutation (see comment above)",
};

/** Every gated write tool, with args that reach its plan phase, which
 * counter must stay at 0 after a plan-only call, and the expected
 * destructiveHint from src/tools/*.ts's own `annotations`. */
const GATED_TOOLS = {
  drive_create_folder: {
    args: { folders: [{ name: "New Folder" }] },
    counterKey: "filesCreate",
    destructive: false,
  },
  drive_rename: {
    args: { items: [{ fileId: "F1", newName: "renamed.pdf" }] },
    counterKey: "filesUpdate",
    destructive: false,
  },
  drive_move: {
    args: { items: [{ fileId: "F1", newParentId: "FOLDER2" }] },
    counterKey: "filesUpdate",
    destructive: false,
  },
  drive_trash: {
    args: { fileIds: ["F1"] },
    counterKey: "filesUpdate",
    destructive: true,
  },
  drive_upload_file: {
    args: { files: [{ name: "note.txt", content_text: "hi" }] },
    counterKey: "filesCreate",
    destructive: false,
  },
  drive_create_upload_session: {
    args: { files: [{ name: "video.mp4", sizeBytes: 1000 }] },
    counterKey: "fetchCalls",
    destructive: false,
  },
  drive_overwrite_file: {
    args: { files: [{ fileId: "F1", content_text: "new content" }] },
    counterKey: "filesUpdate",
    destructive: true,
  },
  drive_share: {
    args: { items: [{ fileId: "F1", role: "reader", type: "user", emailAddress: "x@y.com" }] },
    counterKey: "permissionsCreate",
    destructive: true,
  },
  drive_unshare: {
    args: { items: [{ fileId: "F1", permissionId: "PERM1" }] },
    counterKey: "permissionsDelete",
    destructive: true,
  },
  docs_create: {
    args: { title: "New doc" },
    counterKey: "docsCreate",
    destructive: false,
  },
  docs_append_text: {
    args: { documentId: "D1", text: "more text" },
    counterKey: "docsBatchUpdate",
    destructive: undefined,
  },
  docs_insert_text: {
    args: { documentId: "D1", index: 1, text: "inserted" },
    counterKey: "docsBatchUpdate",
    destructive: undefined,
  },
  docs_replace_text: {
    args: { documentId: "D1", find: "foo", replace: "bar" },
    counterKey: "docsBatchUpdate",
    destructive: true,
  },
  docs_raw_batch_update: {
    args: { documentId: "D1", requests: [{ insertText: { location: { index: 1 }, text: "x" } }] },
    counterKey: "docsBatchUpdate",
    destructive: true,
  },
  skill_version_update: {
    args: { skill_name: "test_skill", new_version: "9.9", new_content: "# content" },
    counterKey: "filesCreate",
    destructive: false,
  },
};

// ── fakes ─────────────────────────────────────────────────────────────────

function makeConsentStore() {
  const manifests = new Map();
  return {
    manifests,
    async createManifest(input) {
      manifests.set(input.id, { ...input, status: "AWAITING_CONSENT", consumedAt: null, userReply: null });
    },
    async getManifest(id, server) {
      const r = manifests.get(id);
      return r && r.server === server ? { ...r } : null;
    },
    async consumeManifest() {
      return null; // this test never confirms — only the plan phase is exercised
    },
    async invalidateManifest() {},
    async appendConsentAudit() {},
    async updateConsentAuditOutcome() {},
  };
}
const CONSENT_CFG = { server: "drive", consentTtlMs: 3_600_000, minConsentGapMs: 2_000, sendBatchMax: 10 };

function makeCounters() {
  return { filesCreate: 0, filesUpdate: 0, filesDelete: 0, permissionsCreate: 0, permissionsDelete: 0, docsCreate: 0, docsBatchUpdate: 0, fetchCalls: 0 };
}

function buildClients(counters) {
  return {
    names: ["personal"],
    defaultName: "personal",
    multi: false,
    resolve: () => ({
      drive: {
        files: {
          get: async ({ fileId }) => ({
            data: {
              id: fileId,
              name: "Existing File.pdf",
              mimeType: "application/pdf",
              parents: ["ROOT"],
              trashed: false,
              md5Checksum: "abc123",
              modifiedTime: "2026-01-01T00:00:00Z",
              size: "100",
            },
          }),
          list: async ({ q }) => {
            // skill_version_update: folder lookups (skill folder + versions/)
            // succeed with a fake folder; the "current top file" lookup
            // returns none (so it's a brand-new skill — no collision).
            if (String(q).includes("mimeType='application/vnd.google-apps.folder'")) {
              return { data: { files: [{ id: "SKILLFOLDER1", name: "folder" }] } };
            }
            return { data: { files: [] } };
          },
          create: async ({ requestBody }) => {
            counters.filesCreate++;
            return { data: { id: "NEW" + counters.filesCreate, name: requestBody?.name ?? "new", webViewLink: "https://drive/NEW" } };
          },
          update: async () => {
            counters.filesUpdate++;
            return { data: { id: "F1", name: "Existing File.pdf", parents: ["FOLDER2"], trashed: true } };
          },
          delete: async () => {
            counters.filesDelete++;
          },
        },
        permissions: {
          list: async () => ({ data: { permissions: [] } }),
          create: async () => {
            counters.permissionsCreate++;
            return { data: { id: "PERM" + counters.permissionsCreate, role: "reader", type: "user", emailAddress: "x@y.com" } };
          },
          delete: async () => {
            counters.permissionsDelete++;
          },
        },
      },
      docs: {
        documents: {
          get: async ({ documentId }) => ({
            data: {
              documentId,
              title: "Existing Doc",
              body: { content: [{ endIndex: 6, paragraph: { elements: [{ textRun: { content: "hello\n" } }] } }] },
            },
          }),
          create: async ({ requestBody }) => {
            counters.docsCreate++;
            return { data: { documentId: "NEWDOC" + counters.docsCreate, title: requestBody?.title ?? "new" } };
          },
          batchUpdate: async () => {
            counters.docsBatchUpdate++;
            return { data: { documentId: "D1", replies: [{ replaceAllText: { occurrencesChanged: 1 } }], writeControl: {} } };
          },
        },
      },
      accessToken: async () => "ya29.FAKE",
    }),
    baseGmailQuery: () => "",
  };
}

async function harness() {
  const counters = makeCounters();
  const clients = buildClients(counters);
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    counters.fetchCalls++;
    return { ok: true, status: 200, headers: { get: () => "https://upload/SESSION" }, text: async () => "", json: async () => ({}) };
  };
  const consentStore = makeConsentStore();
  const consentCtx = { consentStore, consentCfg: CONSENT_CFG, auditStore: null };
  const server = new McpServer({ name: "gate-coverage", version: "0" });
  registerAccountTools(server, clients);
  registerDriveTools(server, clients, consentCtx);
  registerDocsTools(server, clients, consentCtx);
  registerSkillVersionTools(server, clients, consentCtx);
  const cli = new Client({ name: "c", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), cli.connect(a)]);
  return { cli, counters, restoreFetch: () => { globalThis.fetch = origFetch; } };
}

// ═══ enumerate the REAL registry, classify, and cross-check ═════════════════

console.log("\n[1] enumerate registered tools from the real MCP registry (client.listTools())");
const { cli, counters, restoreFetch } = await harness();
const tools = (await cli.listTools()).tools;
check("registry is non-empty (sanity)", tools.length > 10, String(tools.length));

const writes = tools.filter((t) => t.annotations?.readOnlyHint !== true);
const reads = tools.filter((t) => t.annotations?.readOnlyHint === true);
console.log(`   ${tools.length} tool(s) total: ${reads.length} read-only, ${writes.length} write`);

console.log("\n[2] every write tool is EITHER in GATED_TOOLS OR in the explicit allowlist");
const unexpected = [];
for (const t of writes) {
  const gated = t.name in GATED_TOOLS;
  const allowlisted = t.name in UNGATED_WRITE_ALLOWLIST;
  check(`${t.name} — gated or allowlisted`, gated || allowlisted, `neither (new ungated write tool!)`);
  if (!gated && !allowlisted) unexpected.push(t.name);
}
check("no unexpected ungated write tools slipped in", unexpected.length === 0, unexpected.join(", "));
check(
  "no write tool is missing from GATED_TOOLS (count sanity)",
  writes.length === Object.keys(GATED_TOOLS).length + Object.keys(UNGATED_WRITE_ALLOWLIST).filter((n) => writes.some((w) => w.name === n)).length,
  `writes=${writes.length} GATED_TOOLS=${Object.keys(GATED_TOOLS).length}`,
);

console.log("\n[3] every GATED_TOOLS entry is actually registered as a write (schema sanity)");
for (const [name, spec] of Object.entries(GATED_TOOLS)) {
  const t = tools.find((x) => x.name === name);
  check(`${name} is registered`, !!t, "not found in registry");
  check(`${name} is classified as write (no readOnlyHint)`, t && t.annotations?.readOnlyHint !== true, JSON.stringify(t?.annotations));
  check(`${name} carries destructiveHint: ${spec.destructive}`, t?.annotations?.destructiveHint === spec.destructive, JSON.stringify(t?.annotations));
  const props = t?.inputSchema?.properties ?? {};
  check(`${name} schema exposes manifest_id`, "manifest_id" in props, JSON.stringify(Object.keys(props)));
  check(`${name} schema exposes user_reply`, "user_reply" in props, JSON.stringify(Object.keys(props)));
}

console.log("\n[4] behavioural proof: calling each gated tool WITHOUT manifest_id/user_reply never mutates");
for (const [name, spec] of Object.entries(GATED_TOOLS)) {
  const before = counters[spec.counterKey];
  const resp = await cli.callTool({ name, arguments: spec.args });
  const body = text(resp);
  check(`${name} plan call: mutation counter (${spec.counterKey}) unchanged`, counters[spec.counterKey] === before, String(counters[spec.counterKey]));
  check(`${name} plan call: response is a plan, not a success/failure header`, body.includes("### 📤 План"), body.slice(0, 60));
  check(`${name} plan call: no ✅/✏️/📁/❌ success-style header`, !/^[✅✏️📁❌♻️]/.test(body), body.slice(0, 10));
}

console.log("\n[5] read tools genuinely carry readOnlyHint (spot-check, not exhaustive)");
for (const name of ["drive_search", "drive_get_metadata", "drive_download_file", "drive_get_download_url", "drive_get_permissions", "drive_extract_text", "drive_confirm_upload", "drive_consent_audit", "docs_list", "docs_read", "list_accounts"]) {
  const t = tools.find((x) => x.name === name);
  check(`${name} readOnlyHint: true`, t?.annotations?.readOnlyHint === true, JSON.stringify(t?.annotations));
}

restoreFetch();
console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
