#!/usr/bin/env node
/**
 * Offline check of drive_get_download_url and the link store behind it
 * (src/downloads.ts). Google is never contacted — the Drive client is stubbed —
 * and no database is needed: without one, downloads.ts keeps links in memory,
 * which is the path exercised here.
 *
 * ВАЖНО (задача #112): drive_get_download_url — ГЕЙТОВАННЫЙ инструмент.
 * Выданная ссылка сама является доступом (кто её держит — скачает файл без
 * авторизации, отозвать нельзя), поэтому «только чтение» здесь было иллюзией.
 * Блок [0] проверяет, что план НИЧЕГО не выдаёт и что текст подтверждения
 * говорит владельцу правду, а не «получить ссылку».
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

// --- consent-gate fixture (in-memory) ---------------------------------------

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
  async updateConsentAuditOutcome() {},
};
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
const text = async (name, args) => (await raw(name, args)).content[0].text;

/** Plan phase only — returns the raw preview text plus the manifest id. */
async function plan(args) {
  const body = await text("drive_get_download_url", args);
  const m = /план `([a-f0-9-]+)`/.exec(body);
  return { body, manifestId: m?.[1] ?? null };
}

/** Full plan → "да" round trip; returns the parsed execute result. */
async function planExec(args) {
  const { body, manifestId } = await plan(args);
  if (!manifestId) throw new Error(`no manifest id in plan response: ${body.slice(0, 300)}`);
  const execBody = await text("drive_get_download_url", { manifest_id: manifestId, user_reply: "да" });
  return JSON.parse(execBody);
}

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

initDownloads("https://drive.example.com/");
check("trailing slash trimmed from base URL", downloadsAvailable() === true);

// --- 0. the gate itself (задача #112) --------------------------------------

console.log("\n[0] issuing a link is gated — and the confirmation text tells the truth");

const tools = (await client.listTools()).tools;
const t = tools.find((x) => x.name === "drive_get_download_url");
check("no longer marked readOnlyHint", t?.annotations?.readOnlyHint !== true, JSON.stringify(t?.annotations));
check("schema exposes manifest_id", "manifest_id" in (t?.inputSchema?.properties ?? {}), JSON.stringify(Object.keys(t?.inputSchema?.properties ?? {})));
check("schema exposes user_reply", "user_reply" in (t?.inputSchema?.properties ?? {}), JSON.stringify(Object.keys(t?.inputSchema?.properties ?? {})));

const planned = await plan({ files: [{ fileId: "VIDEO" }] });
check("plan response is a plan", planned.body.includes("### 📤 План"), planned.body.slice(0, 60));
check("plan hands out NO link", !planned.body.includes("/dl/"), planned.body.slice(0, 200));
check(
  "plan says the link IS access for anyone holding it",
  /любой, у кого она окажется/i.test(planned.body) && /БЕЗ входа/i.test(planned.body),
  planned.body.slice(0, 400),
);
check("plan says it cannot be revoked", /отозвать выданную ссылку нельзя/i.test(planned.body), planned.body.slice(0, 400));
check("plan states the lifetime", /60 мин/.test(planned.body), planned.body.slice(0, 400));
check(
  "plan spells out what the confirm BUTTON does",
  /Кнопка «✅ Подтвердить» означает: ВЫДАТЬ ссылку/.test(planned.body),
  planned.body.slice(-300),
);
check("plan names the file", planned.body.includes("holiday.mp4"), planned.body.slice(0, 400));

// refusal: the link must not be issued
const refused = await plan({ files: [{ fileId: "VIDEO" }] });
const refusedBody = await text("drive_get_download_url", { manifest_id: refused.manifestId, user_reply: "нет, не надо" });
check("a «нет» refuses", /🛑/.test(refusedBody), refusedBody.slice(0, 120));
check("refusal hands out no link", !refusedBody.includes("/dl/"), refusedBody.slice(0, 200));
check("refused plan is invalidated", manifests.get(refused.manifestId)?.status === "INVALIDATED", manifests.get(refused.manifestId)?.status);

// --- 2. binary file ---------------------------------------------------------

console.log("\n[2] ordinary binary file (after consent)");
out = await planExec({ files: [{ fileId: "VIDEO" }] });
let r = out.results[0];
check("link points at /dl/<token>", /^https:\/\/drive\.example\.com\/dl\/[A-Za-z0-9_-]{20,}$/.test(r.downloadUrl), r.downloadUrl);
check("name preserved", r.name === "holiday.mp4", r.name);
check("mime preserved", r.mimeType === "video/mp4", r.mimeType);
check("size reported", r.size === "734003200", String(r.size));
check("expiry is an ISO timestamp in the future", new Date(r.expiresAt).getTime() > Date.now(), String(r.expiresAt));
check("post-verify re-read the issued link", /Независимая проверка выданных ссылок/.test(out.verification ?? ""), String(out.verification).slice(0, 120));
check("post-verify repeats that it cannot be revoked", /отозвать её нельзя/.test(out.verification ?? ""), String(out.verification).slice(0, 300));
check("consent audit recorded the confirmation", audits.some((a) => a.tool === "drive_get_download_url" && a.outcome === "confirmed"), JSON.stringify(audits.at(-1)));

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
out = await planExec({ files: [{ fileId: "DOC" }] });
r = out.results[0];
check("default export is plain text", r.mimeType === "text/plain", r.mimeType);
check("extension appended to a name that had none", r.name === "Отчёт за июль.txt", r.name);
check("size is null — export size is unknown up front", r.size === null, String(r.size));
target = await resolveDownloadLink(r.downloadUrl.split("/dl/")[1]);
check("export format stored on the token", target.exportMime === "text/plain", String(target.exportMime));

console.log("\n[5] Google Sheet with an explicit export format");
out = await planExec({ files: [{ fileId: "SHEET", exportMimeType: "application/pdf" }] });
r = out.results[0];
check("override respected", r.mimeType === "application/pdf", r.mimeType);
check("pdf extension used", r.name === "Бюджет.pdf", r.name);
out = await planExec({ files: [{ fileId: "SHEET" }] });
check("sheet defaults to csv", out.results[0].name === "Бюджет.csv", out.results[0].name);

// --- 6. failures are per file ----------------------------------------------

console.log("\n[6] one bad id among good ones");
out = await planExec({ files: [{ fileId: "VIDEO" }, { fileId: "GHOST" }] });
check("good file still got a link", typeof out.results[0].downloadUrl === "string", JSON.stringify(out.results[0]));
check("bad file reports its own error", /File not found/.test(out.results[1].error ?? ""), JSON.stringify(out.results[1]));
check("no link leaked for the bad file", out.results[1].downloadUrl === undefined);

// --- 6b. custom TTL is what the user actually approved -----------------------

console.log("\n[6b] custom ttlMinutes is stated in the plan and honoured");
const ttlPlan = await plan({ files: [{ fileId: "VIDEO" }], ttlMinutes: 5 });
check("plan states the requested lifetime", /5 мин/.test(ttlPlan.body), ttlPlan.body.slice(0, 400));
const ttlOut = JSON.parse(await text("drive_get_download_url", { manifest_id: ttlPlan.manifestId, user_reply: "да" }));
const ttlLeft = (new Date(ttlOut.results[0].expiresAt).getTime() - Date.now()) / 60000;
check("issued link honours it", ttlLeft > 4 && ttlLeft <= 5.01, String(ttlLeft));

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

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
