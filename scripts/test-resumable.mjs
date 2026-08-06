#!/usr/bin/env node
/**
 * Offline check of drive_create_upload_session / drive_confirm_upload.
 *
 * Google is never contacted: `fetch` is stubbed and every request is recorded,
 * so we can assert on the exact URL, headers and body the tools send, and on
 * how each Drive response (200/201, 308, 404/410, network error) is reported
 * back to the model. Needs no credentials and no network.
 *
 * drive_create_upload_session is consent-gated (mcp-development-standard/
 * references/gate.md) — every scenario below goes through a plan call (no
 * manifest_id/user_reply) followed by an execute call (manifest_id +
 * user_reply="да") via the `planExec` helper. drive_confirm_upload is NOT
 * gated (pure status query, see the comment in src/tools/drive.ts).
 *
 * БЛОК [12] — регрессия задачи #112: drive_confirm_upload больше НЕ принимает
 * адрес (`uploadUrl`) аргументом. Он принимает непрозрачный `sessionId`, а
 * реальный адрес берёт из своего хранилища — поэтому подсунуть серверу
 * «сходи на 169.254.169.254» через аргумент физически нечем.
 *
 * Usage:
 *   npm test                      # builds, then runs this
 *   node scripts/test-resumable.mjs
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerDriveTools } from "../dist/tools/drive.js";

// --- stubs -----------------------------------------------------------------

const calls = [];
let responder = null;

globalThis.fetch = async (url, init = {}) => {
  calls.push({ url: String(url), method: init.method, headers: init.headers ?? {}, body: init.body });
  return responder(String(url), init);
};

/** Minimal stand-in for a fetch Response. */
function res({ status = 200, headers = {}, body = "" }) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    text: async () => body,
    json: async () => JSON.parse(body),
  };
}

/** Session URIs Google really hands back live on googleapis.com — the guard in
 * src/safeFetch.ts only accepts those, so the stubs use realistic ones. */
const SESSION_URI = (id) =>
  `https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=${id}`;

let filesGet = async () => ({ data: {} });

const fakeClients = {
  names: ["personal"],
  defaultName: "personal",
  multi: false,
  resolve: () => ({
    docs: {},
    drive: { files: { get: (...args) => filesGet(...args) } },
    accessToken: async () => "ya29.FAKE",
  }),
  baseGmailQuery: () => "",
};

// --- consent-gate fixture (in-memory, mirrors sheets-mcp's test harnesses) -

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
// minConsentGapMs: 0 — this fixture calls execute immediately after plan,
// which the anti-doublet check would otherwise refuse (that behaviour has
// its own coverage in test-consent.mjs / test-drive-gate.mjs).
const consentCtx = { consentStore, consentCfg: { server: "drive", consentTtlMs: 3_600_000, minConsentGapMs: 0, sendBatchMax: 10 }, auditStore: null };

const server = new McpServer({ name: "drive-mcp-test", version: "0" });
registerDriveTools(server, fakeClients, consentCtx);
const client = new Client({ name: "test-client", version: "0" });
const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(serverSide), client.connect(clientSide)]);

const parse = (r) => JSON.parse(r.content[0].text);
const raw = async (name, args) => client.callTool({ name, arguments: args });
const call = async (name, args) => parse(await raw(name, args));

/** Runs a gated tool's full plan→execute round trip and returns the parsed
 * execute-call result (the shape the OLD single-shot tests expect). */
async function planExec(name, planArgs) {
  const planResp = await client.callTool({ name, arguments: planArgs });
  const planBody = planResp.content[0].text;
  const m = /план `([a-f0-9-]+)`/.exec(planBody);
  if (!m) throw new Error(`${name}: no manifest id found in plan response: ${planBody.slice(0, 300)}`);
  const execResp = await client.callTool({ name, arguments: { manifest_id: m[1], user_reply: "да" } });
  return parse(execResp);
}

/** Creates one session through the gate and returns its opaque sessionId. */
async function newSession(name = "file.bin") {
  responder = () => res({ status: 200, headers: { location: SESSION_URI(`S-${name}`) } });
  const out = await planExec("drive_create_upload_session", { files: [{ name }] });
  const id = out.results[0].sessionId;
  if (!id) throw new Error(`no sessionId in ${JSON.stringify(out.results[0])}`);
  return id;
}

let failures = 0;
const check = (label, cond, extra = "") => {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${label}${cond ? "" : ` — got: ${extra}`}`);
  if (!cond) failures++;
};

// --- 1. both tools are exposed ---------------------------------------------

console.log("\n[1] tool registration");
const tools = (await client.listTools()).tools;
const names = tools.map((t) => t.name);
check("drive_create_upload_session registered", names.includes("drive_create_upload_session"));
check("drive_confirm_upload registered", names.includes("drive_confirm_upload"));

// --- 2-6. session handshake -------------------------------------------------

console.log("\n[2] create session — full arguments");
calls.length = 0;
responder = () => res({ status: 200, headers: { location: SESSION_URI("SESSION1") } });
let out = await planExec("drive_create_upload_session", {
  files: [{ name: "holiday.mp4", mimeType: "video/mp4", sizeBytes: 734003200, parentId: "FOLDER1" }],
});
let req = calls[0];
check(
  "POST to the upload host",
  req.method === "POST" &&
    req.url.startsWith("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable"),
  req.url,
);
check("bearer token attached", req.headers.Authorization === "Bearer ya29.FAKE", req.headers.Authorization);
check("X-Upload-Content-Type", req.headers["X-Upload-Content-Type"] === "video/mp4", req.headers["X-Upload-Content-Type"]);
check("X-Upload-Content-Length", req.headers["X-Upload-Content-Length"] === "734003200", req.headers["X-Upload-Content-Length"]);
check("metadata carries name + parent", req.body === JSON.stringify({ name: "holiday.mp4", parents: ["FOLDER1"] }), req.body);
check("uploadUrl returned to the caller (client PUTs the bytes there)", out.results[0].uploadUrl.includes("upload_id=SESSION1"), JSON.stringify(out.results[0]));
check("opaque sessionId returned alongside it", typeof out.results[0].sessionId === "string" && out.results[0].sessionId.length >= 20, String(out.results[0].sessionId));
check("sessionId is NOT the address", !String(out.results[0].sessionId).includes("://"), String(out.results[0].sessionId));
check("howTo points at sessionId, not the URL", /sessionId/.test(out.results[0].howTo ?? ""), String(out.results[0].howTo));
check("expiry advertised", typeof out.results[0].expiresAt === "string", String(out.results[0].expiresAt));
check("metadata fields requested up front", /[?&]fields=/.test(req.url), req.url);
check("mode = create", out.results[0].mode === "create", String(out.results[0].mode));
check(
  "howTo spells out the byte range",
  out.results[0].howTo?.includes("Content-Range: bytes 0-734003199/734003200"),
  String(out.results[0].howTo),
);

console.log("\n[3] create session — minimal arguments");
calls.length = 0;
out = await planExec("drive_create_upload_session", { files: [{ name: "notes.bin" }] });
req = calls[0];
check("defaults to octet-stream", req.headers["X-Upload-Content-Type"] === "application/octet-stream", req.headers["X-Upload-Content-Type"]);
check("no size header when size unknown", req.headers["X-Upload-Content-Length"] === undefined, String(req.headers["X-Upload-Content-Length"]));
check("sizeBytes reported as null", out.results[0].sizeBytes === null, String(out.results[0].sizeBytes));
check(
  "howTo falls back to an unknown total",
  out.results[0].howTo?.includes("Content-Range: bytes 0-<end>/*"),
  String(out.results[0].howTo),
);

console.log("\n[3b] create session — replacing an existing file");
calls.length = 0;
responder = () => res({ status: 200, headers: { location: SESSION_URI("REPLACE") } });
out = await planExec("drive_create_upload_session", { files: [{ fileId: "OLDID" }] });
req = calls[0];
check("PATCH on the existing file", req.method === "PATCH" && req.url.includes("/files/OLDID"), `${req.method} ${req.url}`);
check("no metadata changes when only fileId is given", req.body === "{}", String(req.body));
check("mode = replace", out.results[0].mode === "replace", String(out.results[0].mode));
out = await planExec("drive_create_upload_session", { files: [{ fileId: "OLDID", parentId: "FOLDER1" }] });
check("parentId + fileId rejected", /parentId cannot be combined/.test(out.results[0].error ?? ""), JSON.stringify(out.results[0]));
out = await planExec("drive_create_upload_session", { files: [{ mimeType: "text/plain" }] });
check("neither name nor fileId rejected", /Provide `name`/.test(out.results[0].error ?? ""), JSON.stringify(out.results[0]));

console.log("\n[4] create session — Drive refuses");
responder = () => res({ status: 403, body: '{"error":{"message":"storageQuotaExceeded"}}' });
out = await planExec("drive_create_upload_session", { files: [{ name: "big.bin", sizeBytes: 99 }] });
check("HTTP status surfaced", /403/.test(out.results[0].error ?? ""), JSON.stringify(out.results[0]));
check("quota reason kept", /storageQuotaExceeded/.test(out.results[0].error ?? ""), JSON.stringify(out.results[0]));

console.log("\n[5] create session — no Location header");
responder = () => res({ status: 200 });
out = await planExec("drive_create_upload_session", { files: [{ name: "x.bin" }] });
check("missing session URI reported", /no Location header/.test(out.results[0].error ?? ""), JSON.stringify(out.results[0]));

console.log("\n[5b] create session — Location points somewhere it must not");
for (const bad of ["http://169.254.169.254/latest/meta-data/", "http://127.0.0.1:1/x", "https://evil.example/x"]) {
  responder = () => res({ status: 200, headers: { location: bad } });
  out = await planExec("drive_create_upload_session", { files: [{ name: "x.bin" }] });
  check(`Location ${bad} refused, no session stored`, /недопустимый адрес/.test(out.results[0].error ?? ""), JSON.stringify(out.results[0]));
  check(`Location ${bad}: no sessionId handed out`, out.results[0].sessionId === undefined, String(out.results[0].sessionId));
}

console.log("\n[6] create session — one file fails, the other succeeds");
responder = (url, init) =>
  JSON.parse(init.body).name === "good.bin"
    ? res({ status: 200, headers: { location: SESSION_URI("OK") } })
    : res({ status: 500, body: "boom" });
out = await planExec("drive_create_upload_session", { files: [{ name: "good.bin" }, { name: "bad.bin" }] });
check("good file got a session", out.results[0].uploadUrl.includes("upload_id=OK"), JSON.stringify(out.results[0]));
check("bad file isolated to its own error", /500/.test(out.results[1].error ?? ""), JSON.stringify(out.results[1]));

// --- 6b. plan phase never touches Google ------------------------------------

console.log("\n[6b] plan call performs ZERO fetch() calls (nothing created before consent)");
calls.length = 0;
responder = () => {
  throw new Error("fetch must not be called during the plan phase");
};
const planOnlyResp = await client.callTool({
  name: "drive_create_upload_session",
  arguments: { files: [{ name: "should-not-fetch.bin" }] },
});
check("plan call performed no fetch()", calls.length === 0, String(calls.length));
check("plan response is a plan, not a result", planOnlyResp.content[0].text.includes("### 📤 План"), planOnlyResp.content[0].text.slice(0, 60));

// --- 7-11. status queries ---------------------------------------------------
// drive_confirm_upload is NOT gated (pure status query) — single-shot calls,
// addressed by the opaque sessionId the session handshake returned.

console.log("\n[7] confirm — upload still in progress");
const s1 = await newSession("s1.bin");
calls.length = 0;
responder = () => res({ status: 308, headers: { range: "bytes=0-524287" } });
out = await call("drive_confirm_upload", { sessions: [{ sessionId: s1, sizeBytes: 1000000 }] });
req = calls[0];
check("status query is a PUT", req.method === "PUT", req.method);
check("goes to the address the SERVER stored, not one from the model", req.url.includes("upload_id=S-s1.bin"), req.url);
check("Content-Range asks for status", req.headers["Content-Range"] === "bytes */1000000", req.headers["Content-Range"]);
check("no bytes sent", req.body === undefined, String(req.body));
check("no Authorization (session URI is self-authorising)", req.headers.Authorization === undefined, String(req.headers.Authorization));
check("status = incomplete", out.results[0].status === "incomplete", out.results[0].status);
check("bytesReceived = last byte + 1", out.results[0].bytesReceived === 524288, String(out.results[0].bytesReceived));
check("nextOffset matches", out.results[0].nextOffset === 524288, String(out.results[0].nextOffset));
check("result is addressed by sessionId, the URL is not echoed back", out.results[0].sessionId === s1 && out.results[0].uploadUrl === undefined, JSON.stringify(out.results[0]));

console.log("\n[8] confirm — nothing received yet");
const s2 = await newSession("s2.bin");
calls.length = 0;
responder = () => res({ status: 308 });
out = await call("drive_confirm_upload", { sessions: [{ sessionId: s2 }] });
check("unknown size → bytes */*", calls[0].headers["Content-Range"] === "bytes */*", calls[0].headers["Content-Range"]);
check("bytesReceived = 0 without a Range header", out.results[0].bytesReceived === 0, String(out.results[0].bytesReceived));

console.log("\n[9] confirm — upload finished");
const s3 = await newSession("s3.bin");
responder = () => res({ status: 200, body: JSON.stringify({ id: "NEWID", name: "holiday.mp4", mimeType: "video/mp4" }) });
filesGet = async ({ fileId }) => ({
  data: {
    id: fileId,
    name: "holiday.mp4",
    mimeType: "video/mp4",
    size: "734003200",
    webViewLink: "https://drive/NEWID",
  },
});
out = await call("drive_confirm_upload", { sessions: [{ sessionId: s3 }] });
check("status = completed", out.results[0].status === "completed", out.results[0].status);
check("final fileId returned", out.results[0].fileId === "NEWID", String(out.results[0].fileId));
check("link filled in from metadata", out.results[0].webViewLink === "https://drive/NEWID", String(out.results[0].webViewLink));
check("size filled in from metadata", out.results[0].size === "734003200", String(out.results[0].size));

console.log("\n[10] confirm — finished, but metadata lookup fails");
const s4 = await newSession("s4.bin");
responder = () => res({ status: 201, body: JSON.stringify({ id: "NEWID2", name: "a.bin" }) });
filesGet = async () => {
  throw new Error("rate limited");
};
out = await call("drive_confirm_upload", { sessions: [{ sessionId: s4 }] });
check("still reported as completed", out.results[0].status === "completed", out.results[0].status);
check("fileId survives the failed lookup", out.results[0].fileId === "NEWID2", String(out.results[0].fileId));

console.log("\n[11] confirm — session gone / unexpected status / network error");
const s5 = await newSession("s5.bin");
responder = () => res({ status: 404, body: "not found" });
out = await call("drive_confirm_upload", { sessions: [{ sessionId: s5 }] });
check("404 → expired", out.results[0].status === "expired", out.results[0].status);

const s6 = await newSession("s6.bin");
responder = () => res({ status: 410, body: "gone" });
out = await call("drive_confirm_upload", { sessions: [{ sessionId: s6 }] });
check("410 → expired", out.results[0].status === "expired", out.results[0].status);

const s7 = await newSession("s7.bin");
responder = () => res({ status: 500, body: "server error" });
out = await call("drive_confirm_upload", { sessions: [{ sessionId: s7 }] });
check(
  "500 → plain error, no bogus status",
  out.results[0].status === undefined && /500/.test(out.results[0].error ?? ""),
  JSON.stringify(out.results[0]),
);

const sA = await newSession("a.bin");
const sB = await newSession("b.bin");
responder = () => {
  throw new Error("socket hang up");
};
out = await call("drive_confirm_upload", {
  sessions: [{ sessionId: sA }, { sessionId: sB }],
});
check(
  "network failure contained per session, tool still returns",
  out.results.length === 2 && out.results.every((r) => /socket hang up/.test(r.error ?? "")),
  JSON.stringify(out.results),
);

// --- 12. SSRF regression (задача #112) --------------------------------------

console.log("\n[12] the model cannot make the server call an address of its choosing");

const confirmSchema = tools.find((t) => t.name === "drive_confirm_upload")?.inputSchema ?? {};
const sessionProps = confirmSchema.properties?.sessions?.items?.properties ?? {};
check("schema exposes sessionId", "sessionId" in sessionProps, JSON.stringify(Object.keys(sessionProps)));
check("schema no longer exposes uploadUrl", !("uploadUrl" in sessionProps), JSON.stringify(Object.keys(sessionProps)));

calls.length = 0;
responder = () => {
  throw new Error("fetch must not happen for an unknown session");
};
let bad = await raw("drive_confirm_upload", { sessions: [{ uploadUrl: "http://169.254.169.254/latest/meta-data/" }] });
check("a call carrying only uploadUrl is rejected outright", bad.isError === true, bad.content[0].text.slice(0, 120));
check("…and performed no fetch()", calls.length === 0, String(calls.length));

for (const attacker of [
  "http://169.254.169.254/latest/meta-data/",
  "http://metadata.google.internal/computeMetadata/v1/",
  "http://127.0.0.1:1/",
  "http://10.0.0.7/internal",
  "https://evil.example/steal",
]) {
  calls.length = 0;
  out = await call("drive_confirm_upload", { sessions: [{ sessionId: attacker }] });
  check(`«${attacker.slice(0, 44)}» as sessionId → refused`, /не найдена/.test(out.results[0].error ?? ""), JSON.stringify(out.results[0]));
  check(`«${attacker.slice(0, 44)}» → no outgoing request at all`, calls.length === 0, String(calls.length));
}

calls.length = 0;
out = await call("drive_confirm_upload", { sessions: [{ sessionId: "totally-unknown-id" }] });
check("unknown sessionId reported honestly", /не найдена/.test(out.results[0].error ?? ""), JSON.stringify(out.results[0]));
check("unknown sessionId performs no request", calls.length === 0, String(calls.length));

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
