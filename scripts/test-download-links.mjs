#!/usr/bin/env node
/**
 * Offline check of drive_get_download_url and the link store behind it
 * (src/downloads.ts). Google is never contacted — the Drive client is stubbed —
 * and no database is needed: without one, downloads.ts keeps links in memory,
 * which is the path exercised here.
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

const server = new McpServer({ name: "drive-mcp-test", version: "0" });
registerDriveTools(server, fakeClients);
const client = new Client({ name: "test-client", version: "0" });
const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(serverSide), client.connect(clientSide)]);

const raw = async (name, args) => client.callTool({ name, arguments: args });
const call = async (name, args) => JSON.parse((await raw(name, args)).content[0].text);

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

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
