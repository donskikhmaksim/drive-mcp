#!/usr/bin/env node
/**
 * Offline check of drive_get_download_url and the link store behind it
 * (src/downloads.ts). Google is never contacted — the Drive client is stubbed —
 * and no database is needed: without one, downloads.ts keeps links in memory,
 * which is the path exercised here.
 *
 * drive_get_download_url is CONSENT-GATED (the issued link works without any
 * sign-in, lives up to 24h and cannot be revoked), so the calls below go
 * through plan → execute via `planExec`; blocks [9]-[12] cover the gate
 * itself: the plan issues no link, a refusal issues no link, binding drift
 * refuses, and the approved TTL is what actually gets issued.
 *
 * Usage:
 *   npm test                          # builds, then runs this
 *   node scripts/test-download-links.mjs
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerDriveTools } from "../dist/tools/drive.js";
import {
  initDownloads,
  downloadsAvailable,
  issueDownloadLink,
  resolveDownloadLink,
  MAX_TTL_MINUTES,
} from "../dist/downloads.js";

const NATIVE_DOC = "application/vnd.google-apps.document";
const NATIVE_SHEET = "application/vnd.google-apps.spreadsheet";

// Files the stubbed Drive knows about.
const FILES = {
  VIDEO: { id: "VIDEO", name: "holiday.mp4", mimeType: "video/mp4", size: "734003200" },
  DOC: { id: "DOC", name: "Отчёт за июль", mimeType: NATIVE_DOC },
  SHEET: { id: "SHEET", name: "Бюджет", mimeType: NATIVE_SHEET },
};

const fakeClients = {
  names: ["personal"],
  defaultName: "personal",
  multi: false,
  resolve: () => ({
    docs: {},
    drive: {
      files: {
        get: async ({ fileId }) => {
          const f = FILES[fileId];
          if (!f) throw new Error(`File not found: ${fileId}`);
          return { data: f };
        },
      },
    },
    accessToken: async () => "ya29.FAKE",
  }),
  baseGmailQuery: () => "",
};

// --- consent-gate fixture ---------------------------------------------------
// drive_get_download_url is consent-gated (the link is a capability that works
// without any sign-in and cannot be revoked), so every call below goes through
// plan → execute. In-memory manifest store, same shape as test-resumable.mjs.

const manifests = new Map();
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
  async appendConsentAudit() {},
  async updateConsentAuditOutcome() {},
};
// minConsentGapMs: 0 — this fixture calls execute right after plan; the
// anti-doublet check has its own coverage in test-consent.mjs.
const consentCtx = {
  consentStore,
  consentCfg: { server: "drive", consentTtlMs: 3_600_000, minConsentGapMs: 0, sendBatchMax: 10 },
  auditStore: null,
};

const server = new McpServer({ name: "drive-mcp-test", version: "0" });
registerDriveTools(server, fakeClients, consentCtx);
const client = new Client({ name: "test-client", version: "0" });
const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(serverSide), client.connect(clientSide)]);

const raw = async (name, args) => client.callTool({ name, arguments: args });

/** Full plan→execute round trip; returns the parsed execute-call result. */
async function planExec(name, planArgs, userReply = "да") {
  const planResp = await raw(name, planArgs);
  const planBody = planResp.content[0].text;
  const m = /план `([a-f0-9-]+)`/.exec(planBody);
  if (!m) throw new Error(`${name}: no manifest id in plan response: ${planBody.slice(0, 300)}`);
  const execResp = await raw(name, { manifest_id: m[1], user_reply: userReply });
  return JSON.parse(execResp.content[0].text);
}
const call = async (name, args) => planExec(name, args);

let failures = 0;
const check = (label, cond, extra = "") => {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${label}${cond ? "" : ` — got: ${extra}`}`);
  if (!cond) failures++;
};

// --- 1. no public URL configured -------------------------------------------

console.log("\n[1] server without a public URL");
initDownloads(undefined);
check("downloadsAvailable() is false", downloadsAvailable() === false);
let out = await raw("drive_get_download_url", { files: [{ fileId: "VIDEO" }] });
check("tool refuses with a clear error", out.isError === true && /PUBLIC_BASE_URL/.test(out.content[0].text), out.content[0].text);

// --- 2. binary file ---------------------------------------------------------

console.log("\n[2] ordinary binary file");
initDownloads("https://drive.example.com/");
check("trailing slash trimmed from base URL", downloadsAvailable() === true);
out = await call("drive_get_download_url", { files: [{ fileId: "VIDEO" }] });
let r = out.results[0];
check("link points at /dl/<token>", /^https:\/\/drive\.example\.com\/dl\/[A-Za-z0-9_-]{20,}$/.test(r.downloadUrl), r.downloadUrl);
check("name preserved", r.name === "holiday.mp4", r.name);
check("mime preserved", r.mimeType === "video/mp4", r.mimeType);
check("size reported", r.size === "734003200", String(r.size));
check("expiry is an ISO timestamp in the future", new Date(r.expiresAt).getTime() > Date.now(), String(r.expiresAt));

console.log("\n[3] the token resolves to that exact file");
let token = r.downloadUrl.split("/dl/")[1];
let target = await resolveDownloadLink(token);
check("token found", !!target, String(target));
check("resolves to the right file", target.fileId === "VIDEO", target.fileId);
check("no export for a binary", target.exportMime === undefined, String(target.exportMime));
check("account recorded for later resolution", target.account === "personal", target.account);
check("unknown token resolves to null", (await resolveDownloadLink("nope")) === null);

// --- 4-5. Google-native files are exported ---------------------------------

console.log("\n[4] Google Doc — exported, extension added");
out = await call("drive_get_download_url", { files: [{ fileId: "DOC" }] });
r = out.results[0];
check("default export is plain text", r.mimeType === "text/plain", r.mimeType);
check("extension appended to a name that had none", r.name === "Отчёт за июль.txt", r.name);
check("size is null — export size is unknown up front", r.size === null, String(r.size));
target = await resolveDownloadLink(r.downloadUrl.split("/dl/")[1]);
check("export format stored on the token", target.exportMime === "text/plain", String(target.exportMime));

console.log("\n[5] Google Sheet with an explicit export format");
out = await call("drive_get_download_url", { files: [{ fileId: "SHEET", exportMimeType: "application/pdf" }] });
r = out.results[0];
check("override respected", r.mimeType === "application/pdf", r.mimeType);
check("pdf extension used", r.name === "Бюджет.pdf", r.name);
out = await call("drive_get_download_url", { files: [{ fileId: "SHEET" }] });
check("sheet defaults to csv", out.results[0].name === "Бюджет.csv", out.results[0].name);

// --- 6. failures are per file ----------------------------------------------

console.log("\n[6] one bad id among good ones");
out = await call("drive_get_download_url", { files: [{ fileId: "VIDEO" }, { fileId: "GHOST" }] });
check("good file still got a link", typeof out.results[0].downloadUrl === "string", JSON.stringify(out.results[0]));
check("bad file reports its own error", /File not found/.test(out.results[1].error ?? ""), JSON.stringify(out.results[1]));
check("no link leaked for the bad file", out.results[1].downloadUrl === undefined);

// --- 7. lifetime ------------------------------------------------------------

console.log("\n[7] link lifetime");
const shortLived = await issueDownloadLink(
  { account: "personal", fileId: "VIDEO", name: "x.bin", mimeType: "application/octet-stream" },
  1,
);
const minutesUntil = (iso) => (new Date(iso).getTime() - Date.now()) / 60000;
check("1-minute link expires in ~1 minute", minutesUntil(shortLived.expiresAt) > 0.5 && minutesUntil(shortLived.expiresAt) <= 1.01, shortLived.expiresAt);

const clamped = await issueDownloadLink(
  { account: "personal", fileId: "VIDEO", name: "x.bin", mimeType: "application/octet-stream" },
  99999,
);
check(
  "absurd TTL is clamped to the maximum",
  Math.round(minutesUntil(clamped.expiresAt)) <= MAX_TTL_MINUTES,
  clamped.expiresAt,
);

// Expiry is enforced on read, not by a timer: rewind the clock instead of waiting.
const realNow = Date.now;
const expiredToken = shortLived.url.split("/dl/")[1];
check("link works before expiry", (await resolveDownloadLink(expiredToken)) !== null);
Date.now = () => realNow() + 2 * 60_000;
check("link is refused after expiry", (await resolveDownloadLink(expiredToken)) === null);
Date.now = realNow;

// --- 8. tokens are unguessable and distinct --------------------------------

console.log("\n[8] token quality");
const tokens = new Set();
for (let i = 0; i < 20; i++) {
  const link = await issueDownloadLink(
    { account: "personal", fileId: "VIDEO", name: "x.bin", mimeType: "application/octet-stream" },
    5,
  );
  tokens.add(link.url.split("/dl/")[1]);
}
check("20 links → 20 distinct tokens", tokens.size === 20, String(tokens.size));
check("tokens are long enough to be unguessable", [...tokens].every((t) => t.length >= 40), String([...tokens][0]?.length));

// --- 9. consent gate --------------------------------------------------------
// The link works without any sign-in, lives up to 24h and cannot be revoked —
// so issuing one is gated exactly like drive_share.

console.log("\n[9] gate: the plan phase issues NO link and spells out what is being handed out");
{
  const planResp = await raw("drive_get_download_url", { files: [{ fileId: "VIDEO" }] });
  const planBody = planResp.content[0].text;
  check("response is a plan, not a result", planBody.includes("### 📤 План"), planBody.slice(0, 80));
  check("NO link handed out in the plan", !planBody.includes("/dl/"), planBody.slice(0, 200));
  check("plan says the link needs no sign-in", /БЕЗ входа в/.test(planBody), planBody.slice(0, 300));
  check("plan states the lifetime", /Срок жизни/.test(planBody), planBody.slice(0, 300));
  check("plan says it cannot be revoked", /Отозвать выданную ссылку нельзя/.test(planBody), planBody.slice(0, 400));
  check("plan names the file", planBody.includes("holiday.mp4"), planBody.slice(0, 300));
}

console.log("\n[10] gate: user says «нет» → 🛑, no link issued");
{
  const planResp = await raw("drive_get_download_url", { files: [{ fileId: "VIDEO" }] });
  const id = /план `([a-f0-9-]+)`/.exec(planResp.content[0].text)[1];
  const noResp = await raw("drive_get_download_url", { manifest_id: id, user_reply: "нет, не надо" });
  const body = noResp.content[0].text;
  check("refused with 🛑", body.includes("🛑"), body.slice(0, 80));
  check("no link in the refusal", !body.includes("/dl/"), body.slice(0, 200));
  const retry = await raw("drive_get_download_url", { manifest_id: id, user_reply: "да" });
  check("invalidated manifest cannot be reused", retry.content[0].text.includes("🛑"), retry.content[0].text.slice(0, 80));
}

console.log("\n[11] gate: file drifts between plan and execute → 🛑, no link issued (real rehash)");
{
  const planResp = await raw("drive_get_download_url", { files: [{ fileId: "VIDEO" }] });
  const id = /план `([a-f0-9-]+)`/.exec(planResp.content[0].text)[1];
  const before = FILES.VIDEO.name;
  FILES.VIDEO.name = "someone-else-replaced-this.mp4"; // concurrent change
  const execResp = await raw("drive_get_download_url", { manifest_id: id, user_reply: "да" });
  FILES.VIDEO.name = before;
  const body = execResp.content[0].text;
  check("binding drift refused with 🛑", body.includes("🛑") && /изменилось/.test(body), body.slice(0, 200));
  check("no link issued on drift", !body.includes("/dl/"), body.slice(0, 200));
}

console.log("\n[12] gate: TTL is part of the binding (a different TTL is a different consent)");
{
  const planResp = await raw("drive_get_download_url", { files: [{ fileId: "VIDEO" }], ttlMinutes: 30 });
  const planBody = planResp.content[0].text;
  check("plan echoes the requested TTL", /30 мин/.test(planBody), planBody.slice(0, 300));
  const id = /план `([a-f0-9-]+)`/.exec(planBody)[1];
  const out = JSON.parse((await raw("drive_get_download_url", { manifest_id: id, user_reply: "да" })).content[0].text);
  const ttlMin = (new Date(out.results[0].expiresAt).getTime() - Date.now()) / 60000;
  check("issued link honours the approved TTL, not the default", ttlMin > 25 && ttlMin <= 30.1, String(ttlMin));
  check("post-verify report attached", /Независимая проверка выданных ссылок/.test(out.verification ?? ""), String(out.verification).slice(0, 120));
  check("result still carries the no-sign-in warning", /БЕЗ входа в Google-аккаунт/.test(out.note ?? ""), String(out.note));
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
