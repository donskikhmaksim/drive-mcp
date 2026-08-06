#!/usr/bin/env node
/**
 * Reflexive gate-coverage test (ported from gmail-mcp's / sheets-mcp's
 * scripts/test-gate-coverage.mjs — mcp-development-standard
 * `references/development-pipeline.md`, T2 checklist item 4).
 *
 * Does NOT hand-pick which tools to exercise. It lists the tools from the
 * REAL registered MCP registry (`client.listTools()`, i.e. what a model
 * actually sees) and cross-checks them against an explicit allowlist:
 *
 *  - every entry in `GATED_TOOLS` gets a real BEHAVIOURAL check: calling it
 *    WITHOUT manifest_id/user_reply must not reach ANY mutating fake API
 *    call (or hand out any capability), and the response must look like a
 *    plan, not a success header;
 *  - everything else classified as a write MUST be named in
 *    `UNGATED_WRITE_ALLOWLIST` below, with a written reason.
 *
 * HOW A "WRITE" IS DECIDED (rewritten 2026-08-06, security pass):
 * previously this file classified with ONE line —
 *   `tools.filter((t) => t.annotations?.readOnlyHint !== true)`
 * — i.e. purely by the tool's own annotation. That made the check
 * self-referential: sticking `readOnlyHint: true` on a mutating tool made it
 * invisible here, and that is exactly what had happened to
 * drive_confirm_upload, drive_get_download_url and drive_extract_text (all
 * three carried the annotation while making outgoing requests / issuing an
 * unauthenticated download capability / running files.copy+files.delete).
 *
 * So classification is now based on the FACT of a side effect, found by
 * statically parsing src/**\/*.ts (the same registerTool(...) parsing approach
 * as scripts/gen-guide.mjs): for every `server.registerTool("<name>"` the
 * source slice up to the next registration is scanned for side-effect markers
 * (mutating Google API calls, a raw `fetch(`, `issueDownloadLink(`) — AND so
 * are the bodies of local functions that slice calls (up to 3 levels deep),
 * because every gated tool's mutation lives in an extracted `executeXxxCore`
 * helper outside the registration block. Any tool with a marker must be gated
 * or allowlisted, and must NOT claim `readOnlyHint: true`. The annotation is
 * still honoured as an ADDITIONAL signal (a tool that declares itself a write
 * is treated as one), never as the only one.
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
import { initDownloads } from "../dist/downloads.js";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// drive_get_download_url refuses outright when the server does not know its
// own public URL, which would short-circuit the gate check below — give it one.
initDownloads("https://drive.example.test");

let failures = 0;
const check = (label, cond, extra = "") => {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${label}${cond ? "" : ` — got: ${extra}`}`);
  if (!cond) failures++;
};
const text = (r) => r.content[0].text;

/** Tools that DO have a side effect but deliberately ship without a consent
 * gate. Each entry needs a written reason — this is the only escape hatch,
 * and it is meant to be read in review. */
const UNGATED_WRITE_ALLOWLIST = {
  drive_extract_text:
    "OCR: files.copy + files.delete run ONLY against a server-named temporary copy (\"gmcp-ocr-tmp\") created and destroyed inside the same call — the user's own file is never modified, so there is nothing for a human to approve. Not read-only either (real writes into the owner's Drive, delete is permanent, a crash between copy and delete leaves a stray temp file), hence it is listed here rather than annotated readOnlyHint.",
  drive_confirm_upload:
    "Status query only: a zero-length PUT (\"Content-Range: bytes */<total>\") against a resumable session Google already finalised or not — calling it 0, 1 or many times changes nothing. The write it reports on was gated at session creation (drive_create_upload_session), the last point this server controls before bytes move client→Google directly. It is listed here (not annotated read-only) because it DOES make an outgoing request to an address taken from an argument — the surface guarded by assertGoogleUploadUrl (scripts/test-confirm-upload-ssrf.mjs).",
};

/** Fixture for skill_version_update: the tool only accepts a folder that is
 * REALLY a direct child of Skills/ (post-check on `parents`, see
 * src/tools/skill_version.ts's `isChildOf`), so the fake Drive below must
 * answer with a folder whose `name`/`parents` match what was asked — exactly
 * what the live API returns. Same literal id as
 * `SKILLS_ROOT_FOLDER_ID` in src/tools/skill_version.ts (not exported; also
 * duplicated in scripts/test-skill-version-injection.mjs). */
const SKILLS_ROOT_FOLDER_ID = "1kjYll-ULT_Z1CFG80HcwgJR6AaS6CVg9";
const SKILL_FIXTURE_NAME = "test_skill";
const SKILL_FIXTURE_FOLDER_ID = "SKILLFOLDER1";

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
  drive_get_download_url: {
    args: { files: [{ fileId: "F1" }] },
    // Issuing a link touches no Google API — the capability is minted by
    // src/downloads.ts — so the "nothing happened yet" proof is that the plan
    // response contains no link at all.
    counterKey: null,
    forbiddenInPlan: "/dl/",
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
    args: { skill_name: SKILL_FIXTURE_NAME, new_version: "9.9", new_content: "# content" },
    counterKey: "filesCreate",
    destructive: false,
  },
};

// ── static side-effect analysis of src/**/*.ts ────────────────────────────
// Classification by FACT, not by annotation (see the header comment).

/** Markers that mean "this code changes something outside this process". */
const SIDE_EFFECT_MARKERS = [
  ["files.create", /\bfiles\s*\.\s*create\s*\(/],
  ["files.update", /\bfiles\s*\.\s*update\s*\(/],
  ["files.delete", /\bfiles\s*\.\s*delete\s*\(/],
  ["files.copy", /\bfiles\s*\.\s*copy\s*\(/],
  ["permissions.create", /\bpermissions\s*\.\s*create\s*\(/],
  ["permissions.delete", /\bpermissions\s*\.\s*delete\s*\(/],
  ["documents.batchUpdate", /\bdocuments\s*\.\s*batchUpdate\s*\(/],
  ["documents.create", /\bdocuments\s*\.\s*create\s*\(/],
  ["fetch(", /(?<![.\w])fetch\s*\(/],
  ["issueDownloadLink(", /\bissueDownloadLink\s*\(/],
];

const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src");

function sourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(p));
    else if (entry.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

/** Start offsets of every top-level declaration — used as segment boundaries.
 * Deliberately crude (line-anchored, no real parser): a segment can only ever
 * bleed into text that belongs to no other declaration, never into the next
 * function's body, which is what matters for "who calls what". */
const TOP_LEVEL_RE =
  /^(?:export\s+)?(?:async\s+)?function\s+\w+|^(?:export\s+)?(?:const|let|interface|type|class|enum)\s+\w+|^registerAutoExecutor\s*\(|^\s*server\.registerTool\s*\(/gm;

function segmentEnd(src, from) {
  TOP_LEVEL_RE.lastIndex = from + 1;
  const m = TOP_LEVEL_RE.exec(src);
  return m ? m.index : src.length;
}

/** name → source text of every top-level function in the repo, so a tool's
 * registration block can be followed into its extracted `executeXxxCore`. */
const FUNCTION_BODIES = new Map();
/** tool name → { source, file } of its registerTool(...) block. */
const TOOL_BLOCKS = new Map();

for (const file of sourceFiles(SRC_DIR)) {
  const src = readFileSync(file, "utf8");

  const fnRe = /^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/gm;
  let m;
  while ((m = fnRe.exec(src))) {
    const body = src.slice(m.index, segmentEnd(src, m.index));
    // Same name in two files → keep both (concatenate): a marker in either
    // copy must count, false positives are safer here than false negatives.
    FUNCTION_BODIES.set(m[1], (FUNCTION_BODIES.get(m[1]) ?? "") + "\n" + body);
  }

  const toolRe = /server\.registerTool\(\s*["']([^"']+)["']/g;
  while ((m = toolRe.exec(src))) {
    toolRe.lastIndex = m.index + 1;
    const nextIdx = src.indexOf("server.registerTool(", m.index + 1);
    TOOL_BLOCKS.set(m[1], { source: src.slice(m.index, nextIdx < 0 ? src.length : nextIdx), file });
    toolRe.lastIndex = nextIdx < 0 ? src.length : nextIdx;
  }
}

/** All markers reachable from a tool's registration block, following calls to
 * local functions up to `depth` levels (the mutation of every gated tool sits
 * in an extracted core helper, not inline in the block). */
function sideEffectMarkers(toolName, depth = 3) {
  const block = TOOL_BLOCKS.get(toolName);
  if (!block) return null; // registered somewhere this parser cannot see
  const found = new Set();
  const seenFns = new Set();
  const scan = (code, level) => {
    for (const [label, re] of SIDE_EFFECT_MARKERS) if (re.test(code)) found.add(label);
    if (level <= 0) return;
    for (const call of code.matchAll(/\b([A-Za-z_]\w*)\s*\(/g)) {
      const fn = call[1];
      if (seenFns.has(fn) || !FUNCTION_BODIES.has(fn)) continue;
      seenFns.add(fn);
      scan(FUNCTION_BODIES.get(fn), level - 1);
    }
  };
  scan(block.source, depth);
  return [...found];
}

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
            // skill_version_update: folder lookups answer like the live API —
            // the folder that was actually asked for, WITH its `name` and
            // `parents`, because the tool re-checks both before it will touch
            // anything (fail-closed post-check on `parents`). The "current top
            // file" lookup returns none (brand-new skill — no collision).
            if (String(q).includes("mimeType='application/vnd.google-apps.folder'")) {
              if (String(q).includes(`name='${SKILL_FIXTURE_NAME}'`)) {
                return { data: { files: [{ id: SKILL_FIXTURE_FOLDER_ID, name: SKILL_FIXTURE_NAME, parents: [SKILLS_ROOT_FOLDER_ID] }] } };
              }
              if (String(q).includes("name='versions'")) {
                return { data: { files: [{ id: "VERSIONS1", name: "versions", parents: [SKILL_FIXTURE_FOLDER_ID] }] } };
              }
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

// Classification by FACT (static markers) OR by self-declaration (no
// readOnlyHint). Either signal is enough to be treated as a write.
const markersByTool = new Map(tools.map((t) => [t.name, sideEffectMarkers(t.name)]));
const unparsed = tools.filter((t) => markersByTool.get(t.name) === null).map((t) => t.name);
check(
  "every registered tool was found in source by the static parser",
  unparsed.length === 0,
  `not found: ${unparsed.join(", ")}`,
);

const hasEffect = (t) => (markersByTool.get(t.name) ?? []).length > 0;
const writes = tools.filter((t) => hasEffect(t) || t.annotations?.readOnlyHint !== true);
const reads = tools.filter((t) => !writes.includes(t));
console.log(`   ${tools.length} tool(s) total: ${reads.length} read, ${writes.length} write (by side effect and/or annotation)`);
for (const t of writes) {
  console.log(`   · ${t.name}: ${(markersByTool.get(t.name) ?? []).join(", ") || "(no marker — classified by annotation only)"}`);
}

console.log("\n[2] every tool WITH A REAL SIDE EFFECT is EITHER gated OR allowlisted with a reason");
const unexpected = [];
for (const t of writes) {
  const gated = t.name in GATED_TOOLS;
  const allowlisted = t.name in UNGATED_WRITE_ALLOWLIST;
  const markers = (markersByTool.get(t.name) ?? []).join(", ") || "annotation only";
  check(`${t.name} — gated or allowlisted [${markers}]`, gated || allowlisted, "neither (new ungated write tool!)");
  if (!gated && !allowlisted) unexpected.push(t.name);
  // A tool that provably changes something outside this process must never
  // claim to be read-only — that is precisely how three tools stayed
  // invisible to this test before 2026-08-06.
  if (hasEffect(t)) {
    check(
      `${t.name} — does NOT claim readOnlyHint while doing [${markers}]`,
      t.annotations?.readOnlyHint !== true,
      JSON.stringify(t.annotations),
    );
  }
}
check("no unexpected ungated write tools slipped in", unexpected.length === 0, unexpected.join(", "));
check(
  "no write tool is missing from GATED_TOOLS (count sanity)",
  writes.length === Object.keys(GATED_TOOLS).length + Object.keys(UNGATED_WRITE_ALLOWLIST).filter((n) => writes.some((w) => w.name === n)).length,
  `writes=${writes.length} GATED_TOOLS=${Object.keys(GATED_TOOLS).length}`,
);
check(
  "allowlist has no stale entries (every allowlisted tool still exists and still has a side effect)",
  Object.keys(UNGATED_WRITE_ALLOWLIST).every((n) => tools.some((t) => t.name === n && hasEffect(t))),
  Object.keys(UNGATED_WRITE_ALLOWLIST).filter((n) => !tools.some((t) => t.name === n && hasEffect(t))).join(", "),
);
check(
  "every allowlist entry carries a written reason",
  Object.values(UNGATED_WRITE_ALLOWLIST).every((r) => typeof r === "string" && r.length > 40),
  JSON.stringify(UNGATED_WRITE_ALLOWLIST),
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
  const before = spec.counterKey ? counters[spec.counterKey] : null;
  const resp = await cli.callTool({ name, arguments: spec.args });
  const body = text(resp);
  if (spec.counterKey) {
    check(`${name} plan call: mutation counter (${spec.counterKey}) unchanged`, counters[spec.counterKey] === before, String(counters[spec.counterKey]));
  }
  if (spec.forbiddenInPlan) {
    check(`${name} plan call: no «${spec.forbiddenInPlan}» handed out before consent`, !body.includes(spec.forbiddenInPlan), body.slice(0, 120));
  }
  check(`${name} plan call: response is a plan, not a success/failure header`, body.includes("### 📤 План"), body.slice(0, 60));
  check(`${name} plan call: no ✅/✏️/📁/❌ success-style header`, !/^[✅✏️📁❌♻️]/.test(body), body.slice(0, 10));
}

console.log("\n[5] genuine read tools carry readOnlyHint — AND have no side-effect marker");
// The two lists are checked against each other on purpose: a tool may sit
// here only if BOTH signals agree (annotation says read, source shows no
// mutation). drive_extract_text / drive_confirm_upload used to be in this
// list purely on their annotation — they are writes and now live in
// UNGATED_WRITE_ALLOWLIST instead.
for (const name of ["drive_search", "drive_get_metadata", "drive_download_file", "drive_get_permissions", "drive_consent_audit", "docs_list", "docs_read", "list_accounts"]) {
  const t = tools.find((x) => x.name === name);
  check(`${name} readOnlyHint: true`, t?.annotations?.readOnlyHint === true, JSON.stringify(t?.annotations));
  check(`${name} has no side-effect marker in source`, (markersByTool.get(name) ?? []).length === 0, (markersByTool.get(name) ?? []).join(", "));
}

restoreFetch();
console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
