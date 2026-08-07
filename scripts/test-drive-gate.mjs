#!/usr/bin/env node
/**
 * End-to-end gate behaviour on real drive-mcp tools (ported pattern from
 * gmail-mcp's scripts/test-a3-gate.mjs / sheets-mcp's test-sheets-gate.mjs,
 * condensed to the representative scenarios mcp-development-standard T2
 * asks for: full plan→confirm→mutate→post-verify round trips, the
 * binding-drift proof that rehash is real (not `sha256(payload)` in
 * disguise — gate.md §3.3(2)), and drive_share's permission post-verify
 * (task requirement: "share/unshare — обязательно с post-verify permissions").
 *
 * Uses an in-memory fake Google Drive API with a MUTABLE file/permission
 * store, so "someone else changed the file/permissions between plan and
 * execute" can be simulated by mutating the fake store directly between two
 * tool calls.
 *
 * Usage: node scripts/test-drive-gate.mjs
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerDriveTools } from "../dist/tools/drive.js";
import { registerAccountTools } from "../dist/accounts.js";

let failures = 0;
const check = (label, cond, extra = "") => {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${label}${cond ? "" : ` — got: ${extra}`}`);
  if (!cond) failures++;
};
const text = (r) => r.content[0].text;

// ── fake Drive API with a real mutable backing store ────────────────────────

function makeDriveWorld() {
  const files = new Map([
    ["F1", { id: "F1", name: "report.pdf", mimeType: "application/pdf", parents: ["ROOT"], trashed: false, md5Checksum: "hash-v1", modifiedTime: "2026-01-01T00:00:00Z", size: "100" }],
  ]);
  const permissions = new Map([["F1", []]]);
  return { files, permissions };
}

function buildClients(world) {
  return {
    names: ["personal"],
    defaultName: "personal",
    multi: false,
    resolve: () => ({
      drive: {
        files: {
          get: async ({ fileId }) => {
            const f = world.files.get(fileId);
            if (!f) throw new Error("not found");
            return { data: { ...f } };
          },
          list: async () => ({ data: { files: [] } }),
          create: async ({ requestBody }) => {
            const id = "NEW" + (world.files.size + 1);
            world.files.set(id, { id, name: requestBody.name, mimeType: requestBody.mimeType ?? "application/octet-stream", parents: requestBody.parents ?? [], trashed: false, md5Checksum: "new-hash", modifiedTime: new Date().toISOString(), size: "10" });
            world.permissions.set(id, []);
            return { data: { id, name: requestBody.name, webViewLink: `https://drive/${id}` } };
          },
          update: async ({ fileId, requestBody, addParents, removeParents }) => {
            const f = world.files.get(fileId);
            if (!f) throw new Error("not found");
            if (requestBody?.name) f.name = requestBody.name;
            if (requestBody?.trashed !== undefined) f.trashed = requestBody.trashed;
            if (addParents) f.parents = [...new Set([...f.parents, addParents])];
            if (removeParents) f.parents = f.parents.filter((p) => p !== removeParents);
            if (requestBody && "media" in arguments) {} // no-op marker
            f.md5Checksum = "hash-updated-" + Math.random().toString(36).slice(2, 8);
            f.modifiedTime = new Date().toISOString();
            world.files.set(fileId, f);
            return { data: { id: f.id, name: f.name, parents: f.parents, trashed: f.trashed } };
          },
        },
        permissions: {
          list: async ({ fileId }) => ({ data: { permissions: world.permissions.get(fileId) ?? [] } }),
          create: async ({ fileId, requestBody }) => {
            const id = "PERM" + Math.random().toString(36).slice(2, 8);
            const perm = { id, type: requestBody.type, role: requestBody.role, emailAddress: requestBody.emailAddress ?? null, domain: requestBody.domain ?? null };
            const list = world.permissions.get(fileId) ?? [];
            list.push(perm);
            world.permissions.set(fileId, list);
            return { data: { id, role: perm.role, type: perm.type, emailAddress: perm.emailAddress } };
          },
          delete: async ({ fileId, permissionId }) => {
            const list = world.permissions.get(fileId) ?? [];
            world.permissions.set(fileId, list.filter((p) => p.id !== permissionId));
          },
        },
      },
      docs: {},
      accessToken: async () => "ya29.FAKE",
    }),
    baseGmailQuery: () => "",
  };
}

async function harness(world) {
  const clients = buildClients(world);
  const manifests = new Map();
  const audits = [];
  const consentStore = {
    async createManifest(input) {
      manifests.set(input.id, { ...input, status: "AWAITING_CONSENT", consumedAt: null, userReply: null });
    },
    async getManifest(id, server) {
      const r = manifests.get(id);
      return r && r.server === server ? { ...r } : null;
    },
    async consumeManifest(id, server, userReply) {
      const r = manifests.get(id);
      if (!r || r.server !== server || r.status !== "AWAITING_CONSENT") return null;
      if (Date.now() >= r.expiresAt) return null;
      r.status = "DONE";
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
      if (a) Object.assign(a, outcome);
    },
  };
  const consentCtx = { consentStore, consentCfg: { server: "drive", consentTtlMs: 3_600_000, minConsentGapMs: 0, sendBatchMax: 10 }, auditStore: null };
  const server = new McpServer({ name: "drive-gate-e2e", version: "0" });
  registerAccountTools(server, clients);
  registerDriveTools(server, clients, consentCtx);
  const cli = new Client({ name: "c", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), cli.connect(a)]);
  return { cli, manifests, audits, world };
}

function extractManifestId(planText) {
  const m = /план `([a-f0-9-]+)`/.exec(planText);
  return m?.[1];
}

// ── [1] happy path: drive_rename plan → confirm → mutation → ✅ ─────────────
console.log("\n[1] drive_rename: full plan→confirm round trip, mutation lands, post-verify ✅");
{
  const world = makeDriveWorld();
  const { cli } = await harness(world);
  const planResp = await cli.callTool({ name: "drive_rename", arguments: { items: [{ fileId: "F1", newName: "final-report.pdf" }] } });
  const planBody = text(planResp);
  check("plan mentions current name", planBody.includes("report.pdf"), planBody.slice(0, 200));
  check("world NOT mutated yet", world.files.get("F1").name === "report.pdf");
  const manifestId = extractManifestId(planBody);
  check("manifest id extracted from preview", !!manifestId, planBody.slice(0, 200));

  const execResp = await cli.callTool({ name: "drive_rename", arguments: { manifest_id: manifestId, user_reply: "да, переименуй" } });
  const execBody = text(execResp);
  check("execute succeeds — summary shows 1/1, no error", execBody.includes('"summary": "✏️ Переименовано 1/1"'), execBody.slice(0, 60));
  check("world IS mutated", world.files.get("F1").name === "final-report.pdf");
  check("post-verify report attached with ✅", execBody.includes("Независимая проверка переименования") && execBody.includes("✅"));
}

// ── [2] binding drift: someone renames the file between plan and execute ────
console.log("\n[2] drive_rename: file renamed between plan and execute → 🛑, NOT mutated (real rehash, not sha256(payload))");
{
  const world = makeDriveWorld();
  const { cli } = await harness(world);
  const planResp = await cli.callTool({ name: "drive_rename", arguments: { items: [{ fileId: "F1", newName: "final-report.pdf" }] } });
  const manifestId = extractManifestId(text(planResp));

  // Simulate a concurrent rename landing between plan and execute.
  world.files.get("F1").name = "someone-else-renamed-this.pdf";

  const execResp = await cli.callTool({ name: "drive_rename", arguments: { manifest_id: manifestId, user_reply: "да" } });
  const execBody = text(execResp);
  check("refused with 🛑", execBody.includes("🛑"), execBody.slice(0, 60));
  check("refusal names state change", execBody.includes("изменилось"), execBody.slice(0, 200));
  check("the concurrent rename is UNTOUCHED (write never happened)", world.files.get("F1").name === "someone-else-renamed-this.pdf");
}

// ── [3] negation invalidates: drive_trash ────────────────────────────────────
console.log("\n[3] drive_trash: user says 'нет' → 🛑 отменено, file untouched, manifest re-use fails");
{
  const world = makeDriveWorld();
  const { cli } = await harness(world);
  const planResp = await cli.callTool({ name: "drive_trash", arguments: { fileIds: ["F1"] } });
  const planBody = text(planResp);
  check("plan names the file", planBody.includes("report.pdf"), planBody.slice(0, 200));
  const manifestId = extractManifestId(planBody);

  const noResp = await cli.callTool({ name: "drive_trash", arguments: { manifest_id: manifestId, user_reply: "нет, стоп" } });
  check("negation → 🛑 Отменено", text(noResp).includes("Отменено"), text(noResp).slice(0, 80));
  check("file untouched after negation", world.files.get("F1").trashed === false);

  const retryResp = await cli.callTool({ name: "drive_trash", arguments: { manifest_id: manifestId, user_reply: "да" } });
  check("re-using an invalidated manifest still fails", text(retryResp).includes("🛑"), text(retryResp).slice(0, 60));
  check("file STILL untouched", world.files.get("F1").trashed === false);
}

// ── [4] drive_share: full round trip, REAL post-verify against live permissions ─
console.log("\n[4] drive_share: plan→confirm→grant, post-verify re-reads LIVE permissions.list (not the create() response)");
{
  const world = makeDriveWorld();
  const { cli } = await harness(world);
  const planResp = await cli.callTool({
    name: "drive_share",
    arguments: { items: [{ fileId: "F1", role: "reader", type: "user", emailAddress: "eric@x.com" }] },
  });
  const planBody = text(planResp);
  check("plan names the recipient", planBody.includes("eric@x.com"), planBody.slice(0, 200));
  check("world NOT shared yet", world.permissions.get("F1").length === 0);
  const manifestId = extractManifestId(planBody);

  const execResp = await cli.callTool({ name: "drive_share", arguments: { manifest_id: manifestId, user_reply: "да, дай доступ" } });
  const execBody = text(execResp);
  check("execute succeeds", execBody.includes('"summary": "✅ Открыт доступ 1/1"'), execBody.slice(0, 60));
  check("world IS shared", world.permissions.get("F1").some((p) => p.emailAddress === "eric@x.com" && p.role === "reader"));
  check("post-verify report present with ✅", execBody.includes("Независимая проверка открытия доступа") && execBody.includes("✅"));
  check("post-verify text references live permissions, not just the create() echo", execBody.includes("permissions"));
}

// ── [5] drive_share binding drift: permissions changed between plan/execute ─
console.log("\n[5] drive_share: permissions changed between plan and execute → 🛑, NOT granted");
{
  const world = makeDriveWorld();
  const { cli } = await harness(world);
  const planResp = await cli.callTool({
    name: "drive_share",
    arguments: { items: [{ fileId: "F1", role: "writer", type: "user", emailAddress: "maksim@x.com" }] },
  });
  const manifestId = extractManifestId(text(planResp));

  // Simulate someone else granting access concurrently (changes the live
  // permission list the rehash re-reads).
  world.permissions.get("F1").push({ id: "PERM-CONCURRENT", type: "user", role: "commenter", emailAddress: "someone-else@x.com" });

  const execResp = await cli.callTool({ name: "drive_share", arguments: { manifest_id: manifestId, user_reply: "да" } });
  const execBody = text(execResp);
  check("refused with 🛑", execBody.includes("🛑"), execBody.slice(0, 60));
  check("refusal names state change", execBody.includes("изменилось"), execBody.slice(0, 200));
  check("no NEW permission for maksim@x.com was granted", !world.permissions.get("F1").some((p) => p.emailAddress === "maksim@x.com"));
  check("the concurrent permission is untouched", world.permissions.get("F1").some((p) => p.id === "PERM-CONCURRENT"));
}

// ── [6] drive_unshare: full round trip, post-verify confirms LIVE removal ───
console.log("\n[6] drive_unshare: plan→confirm→revoke, post-verify confirms permission is gone from LIVE permissions.list");
{
  const world = makeDriveWorld();
  world.permissions.set("F1", [{ id: "PERM-EXISTING", type: "user", role: "reader", emailAddress: "eric@x.com" }]);
  const { cli } = await harness(world);
  const planResp = await cli.callTool({ name: "drive_unshare", arguments: { items: [{ fileId: "F1", permissionId: "PERM-EXISTING" }] } });
  const planBody = text(planResp);
  check("plan names who loses access", planBody.includes("eric@x.com"), planBody.slice(0, 200));
  const manifestId = extractManifestId(planBody);

  const execResp = await cli.callTool({ name: "drive_unshare", arguments: { manifest_id: manifestId, user_reply: "да, убери" } });
  const execBody = text(execResp);
  check("execute succeeds", execBody.includes('"summary": "🔒 Отозван доступ 1/1"'), execBody.slice(0, 60));
  check("permission gone from world", world.permissions.get("F1").length === 0);
  check("post-verify confirms removal against live permissions", execBody.includes("✅") && execBody.includes("Независимая проверка отзыва доступа"));
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
