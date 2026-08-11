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
 * исключений") the allowlist stays tiny and every entry carries a reason.
 *
 * CLASSIFICATION NO LONGER TRUSTS THE TOOL'S OWN LABEL (ported from gmail-mcp
 * 2026-08-06). A tool is a WRITE if EITHER it lacks `readOnlyHint: true` OR a
 * static scan of the sources finds a real side effect in the code it reaches.
 *
 * Why this matters more than the two fixes that prompted it. Until today the
 * rule here was the tool's own hand-written `readOnlyHint`, and that is
 * exactly how two tools hid: `drive_extract_text` declared `readOnlyHint: true`
 * while copying a file and permanently deleting the copy, and
 * `drive_confirm_upload` KEPT its `readOnlyHint: true` even after its own SSRF
 * hole was fixed — the behaviour was repaired and the sign left hanging. Both
 * were counted as READS, so their allowlist entries below could never fire.
 * That is a repeating failure mode, not two accidents: people fix behaviour
 * and forget to take down the label. A label is a claim; this file now checks
 * the claim against the code.
 *
 * Scope of the scan (deliberately narrow, so it cannot cry wolf): the markers
 * are genuine changes out in the world or capabilities handed out — Drive
 * files.create/update/delete/copy, permissions.*, Docs documents.create/
 * batchUpdate, raw fetch(), outbound safeGoogleFetch(), issueDownloadLink(),
 * and writes into this server's own upload-session store. Verified against the
 * live registry when ported: 18 writes / 8 reads, zero false positives.
 *
 * Usage: node scripts/test-gate-coverage.mjs
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerDriveTools } from "../dist/tools/drive.js";
import { registerDocsTools } from "../dist/tools/docs.js";
import { registerSkillVersionTools } from "../dist/tools/skill_version.js";
import { registerAccountTools } from "../dist/accounts.js";
import { initDownloads } from "../dist/downloads.js";
import { registeredAutoExecuteTools } from "../dist/autoExecute.js";

let failures = 0;
const check = (label, cond, extra = "") => {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${label}${cond ? "" : ` — got: ${extra}`}`);
  if (!cond) failures++;
};
const text = (r) => r.content[0].text;

// ── static scan of the sources for REAL side effects ───────────────────────
// Ported from gmail-mcp with Drive-shaped markers. The point is to classify a
// tool by what its code DOES, not by what its annotation SAYS.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_FILES = [
  ...readdirSync(join(ROOT, "src", "tools"))
    .filter((f) => f.endsWith(".ts"))
    .map((f) => join(ROOT, "src", "tools", f)),
  join(ROOT, "src", "accounts.ts"),
];

/** Each marker is a genuine change out in the world (or a capability handed
 * out), never a naming convention — a false positive here would train people
 * to silence this test, which is worse than the hole it closes. */
const SIDE_EFFECT_MARKERS = [
  ["drive files.create/update/delete/copy", /\bfiles\s*\.\s*(?:create|update|delete|copy)\s*\(/],
  ["drive permissions.create/update/delete", /\bpermissions\s*\.\s*(?:create|update|delete)\s*\(/],
  ["docs documents.create/batchUpdate", /\bdocuments\s*\.\s*(?:create|batchUpdate)\s*\(/],
  ["raw fetch()", /(?<![A-Za-z0-9_$.])fetch\s*\(/],
  // Исходящий запрос через проверенный транспорт — всё равно запрос НАРУЖУ.
  // Прятаться за тем, что он «безопасный», нельзя: маркер ловит ровно то же,
  // что и голый fetch(, просто после переезда на safeFetch.ts.
  ["outbound request (safeGoogleFetch)", /\bsafeGoogleFetch\s*\(/],
  ["capability minted (issueDownloadLink)", /\bissueDownloadLink\s*\(/],
  ["own store write", /\b(?:rememberUploadSession)\s*\(/],
];

/** Reads the balanced {...} block that starts at/after `from`. */
function bracedBlockAt(src, from) {
  const start = src.indexOf("{", from);
  if (start < 0) return "";
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return src.slice(start, i + 1);
  }
  return src.slice(start);
}

/** Module-level functions, by name → body. Covers both declaration styles
 * used in this repo (`function f()` and `const f = async (…) => {`). */
function moduleFunctions(src) {
  const out = new Map();
  const decl = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/gm;
  const arrow = /^(?:export\s+)?const\s+([A-Za-z0-9_$]+)\s*(?::[^=\n]+)?=\s*(?:async\s*)?\([^)]*\)\s*(?::[^=>\n]+)?=>\s*\{/gm;
  for (const re of [decl, arrow]) {
    let m;
    while ((m = re.exec(src))) out.set(m[1], bracedBlockAt(src, m.index));
  }
  return out;
}

/** Every `server.registerTool("name", …)` block: from its own call up to the
 * next registration (or EOF). */
function toolBlocks(src) {
  const re = /server\.registerTool\(\s*["']([^"']+)["']/g;
  const marks = [];
  let m;
  while ((m = re.exec(src))) marks.push({ name: m[1], at: m.index });
  return marks.map((mk, i) => ({
    name: mk.name,
    code: src.slice(mk.at, i + 1 < marks.length ? marks[i + 1].at : src.length),
  }));
}

/** Block code + the bodies of every module-level function it reaches — a tool
 * that hides its write one call deep is still a write. */
function reachableCode(blockCode, fns) {
  const seen = new Set();
  const parts = [blockCode];
  const queue = [blockCode];
  const callRe = /\b([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g;
  while (queue.length) {
    const code = queue.shift();
    let m;
    callRe.lastIndex = 0;
    while ((m = callRe.exec(code))) {
      const name = m[1];
      if (seen.has(name) || !fns.has(name)) continue;
      seen.add(name);
      const body = fns.get(name);
      parts.push(body);
      queue.push(body);
    }
  }
  return parts.join("\n");
}

/** name → [marker labels] for every tool found in source. */
function scanSideEffects() {
  const found = new Map();
  for (const file of SOURCE_FILES) {
    const src = readFileSync(file, "utf8");
    const fns = moduleFunctions(src);
    for (const { name, code } of toolBlocks(src)) {
      const all = reachableCode(code, fns);
      const markers = SIDE_EFFECT_MARKERS.filter(([, re]) => re.test(all)).map(([label]) => label);
      const prev = found.get(name) ?? [];
      found.set(name, [...new Set([...prev, ...markers])]);
    }
  }
  return found;
}

const SIDE_EFFECTS = scanSideEffects();
const hasSideEffect = (name) => (SIDE_EFFECTS.get(name) ?? []).length > 0;
const markersOf = (name) => SIDE_EFFECTS.get(name) ?? [];

const UNGATED_WRITE_ALLOWLIST = {
  drive_extract_text:
    "OCR — рутинный вопрос-чтение («что в этом скане?»); гейт на каждый такой вызов приучил бы штамповать " +
    "подтверждения. Но это WRITE и он больше не притворяется: Google-OCR обязан материализовать настоящий " +
    "Google Doc в Диске владельца, поэтому readOnlyHint снят, черновая копия уезжает в КОРЗИНУ (не files.delete), " +
    "identity-guard не даёт тронуть ничего, кроме нашего же «gmcp-ocr-tmp», а провалившаяся уборка попадает в " +
    "ОТВЕТ инструмента, а не только в лог — см. scripts/test-ocr-cleanup.mjs.",
  drive_confirm_upload:
    "ничего не мутирует — статус-запрос; адрес НЕ приходит от модели (сервер хранит его сам, наружу отдан " +
    "непрозрачный sessionId), исходящий запрос идёт через safeGoogleFetch. Но исходящий запрос — это не " +
    "read-only, поэтому readOnlyHint снят (2026-08-06): пометка прятала тул от этой самой проверки.",
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
  // Выдача ссылки — НЕ чтение (задача #112): ссылка сама является доступом,
  // отозвать её нельзя. Мутирующих вызовов Drive у этого тула нет, поэтому
  // «ничего не произошло» проверяется иначе — в ответе плана не должно быть
  // ни одной выданной ссылки (`/dl/<token>`).
  drive_get_download_url: {
    args: { files: [{ fileId: "F1" }] },
    counterKey: "filesCreate",
    forbiddenInPlan: /\/dl\//,
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
    args: { skill_name: SKILL_FIXTURE_NAME, new_version: "9.9", new_content: "# content" },
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
  // Без известного публичного адреса drive_get_download_url отказывает ДО
  // гейта («не знаю своего адреса»), и проверка гейта была бы холостой.
  initDownloads("https://links.example");
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

// Классификация НЕ по одной лишь самопометке: тул считается write, если он
// либо не заявил readOnlyHint, либо статический скан нашёл у него настоящий
// побочный эффект. Второе условие и есть то, чего здесь не хватало: ровно так
// прятались drive_extract_text и drive_confirm_upload.
const writes = tools.filter((t) => hasSideEffect(t.name) || t.annotations?.readOnlyHint !== true);
const reads = tools.filter((t) => !hasSideEffect(t.name) && t.annotations?.readOnlyHint === true);
console.log(`   ${tools.length} tool(s) total: ${reads.length} read-only, ${writes.length} write`);
for (const t of writes) {
  const why = hasSideEffect(t.name) ? `side effects: ${markersOf(t.name).join(", ")}` : "no readOnlyHint";
  console.log(`     write: ${t.name.padEnd(30)} ${why}`);
}

console.log("\n[2] every write tool is EITHER in GATED_TOOLS OR in the explicit allowlist");
const unexpected = [];
for (const t of writes) {
  const gated = t.name in GATED_TOOLS;
  const allowlisted = t.name in UNGATED_WRITE_ALLOWLIST;
  check(`${t.name} — gated or allowlisted`, gated || allowlisted, `neither (new ungated write tool!)`);
  if (!gated && !allowlisted) unexpected.push(t.name);
}
check("no unexpected ungated write tools slipped in", unexpected.length === 0, unexpected.join(", "));

console.log("\n[2b] a tool with a REAL side effect must NOT claim readOnlyHint (no hiding behind the label)");
// Именно эта проверка ловит повторяющуюся ошибку «починили поведение, а
// вывеску забыли снять»: так drive_confirm_upload пережил починку собственной
// дыры, оставшись помеченным как «только чтение».
for (const t of tools.filter((x) => hasSideEffect(x.name))) {
  check(
    `${t.name} does not claim readOnlyHint (${markersOf(t.name).join(", ")})`,
    t.annotations?.readOnlyHint !== true,
    JSON.stringify(t.annotations),
  );
}
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
  if (spec.forbiddenInPlan) {
    check(`${name} plan call: hands out nothing (${spec.forbiddenInPlan})`, !spec.forbiddenInPlan.test(body), body.slice(0, 200));
  }
  check(`${name} plan call: no ✅/✏️/📁/❌ success-style header`, !/^[✅✏️📁❌♻️]/.test(body), body.slice(0, 10));
}

console.log("\n[5] read tools genuinely carry readOnlyHint (spot-check, not exhaustive)");
for (const name of ["drive_search", "drive_get_metadata", "drive_download_file", "drive_get_permissions", "drive_consent_audit", "docs_list", "docs_read", "list_accounts"]) {
  const t = tools.find((x) => x.name === name);
  check(`${name} readOnlyHint: true`, t?.annotations?.readOnlyHint === true, JSON.stringify(t?.annotations));
}

console.log("\n[6] every gated tool can also be executed by the Telegram button (auto-executor registered)");
// Иначе подтверждение кнопкой переключило бы флаг, а само действие не
// наступило бы никогда, пока модель не позовёт инструмент второй раз.
const autoTools = new Set(registeredAutoExecuteTools());
for (const name of Object.keys(GATED_TOOLS)) {
  check(`${name} has an auto-executor`, autoTools.has(name), [...autoTools].join(", "));
}

restoreFetch();
console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
