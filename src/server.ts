import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { User } from "./config.js";
import { loadConsentGateConfig, loadTgApprovalConfig } from "./config.js";
import { buildUserClients, registerAccountTools } from "./accounts.js";
import { registerDriveTools, type DriveConsentContext } from "./tools/drive.js";
import { registerDocsTools } from "./tools/docs.js";
import { registerSkillVersionTools } from "./tools/skill_version.js";
import type { ConsentStore, ConsentConfig } from "./consent.js";
import type { TgApprovalGate, TgApprovalStore } from "./tg_approval.js";
import { createTgApprovalGate } from "./tg_approval.js";
import {
  storeReady,
  createManifest,
  getManifest,
  consumeManifest,
  invalidateManifest,
  appendConsentAudit,
  updateConsentAuditOutcome,
  listConsentAudit,
  countConsentAudit,
  createTgApproval,
  getTgApproval,
  consumeTgDecision,
  consumeTgDecisionAnyServer,
} from "./store.js";

/**
 * store.ts's consent-gate functions (ported from gmail-mcp package A1), typed
 * against consent.ts's `ConsentStore` here — signature-for-signature by
 * construction, but the `: ConsentStore` annotation means a drift fails THIS
 * build, not the tool file's.
 */
export const consentStoreAdapter: ConsentStore = {
  createManifest,
  getManifest,
  consumeManifest,
  invalidateManifest,
  appendConsentAudit,
  updateConsentAuditOutcome,
};

/**
 * Read-only adapter for `drive_consent_audit` — separate from
 * `consentStoreAdapter` above (the plan/execute gate contract) since this is
 * a different, purely-reading surface: "разбор инцидента без ssh"
 * (limits-audit.md §11).
 */
export const auditStoreAdapter = { listConsentAudit, countConsentAudit };

/** This server's identity ($self = "drive") in the shared consent_manifests/
 * consent_audit tables, plus the gate's TTL/anti-doublet/batch-cap knobs —
 * env-driven, see `loadConsentGateConfig` in config.ts. `now` is left unset
 * here (real `Date.now`); consent.ts's `now` injection exists for OFFLINE
 * UNIT TESTS only. */
const consentGateEnv = loadConsentGateConfig();
export const consentServerConfig: ConsentConfig = {
  server: consentGateEnv.server,
  consentTtlMs: consentGateEnv.consentTtlMs,
  minConsentGapMs: consentGateEnv.minConsentGapMs,
  sendBatchMax: consentGateEnv.sendBatchMax,
};

/**
 * Optional Telegram-approval layer (plan-tg-approval.md). Loaded once at
 * module scope, same as `consentGateEnv`/`consentServerConfig` above — this
 * throws loudly at process start if TG_APPROVAL_ENABLED=true but misconfigured
 * (package P0), rather than silently degrading. Exported so http.ts can mount
 * `/tg/webhook` and call `registerWebhook()` at startup without re-deriving it.
 */
export const tgApprovalConfig = loadTgApprovalConfig(consentGateEnv.server);

/** store.ts's tg_approvals functions (package P1), typed against
 * tg_approval.ts's `TgApprovalStore` here — signature-for-signature by
 * construction, same discipline as `consentStoreAdapter` above. */
export const tgApprovalStoreAdapter: TgApprovalStore = {
  createTgApproval,
  getTgApproval,
  consumeTgDecision,
  consumeTgDecisionAnyServer,
};

/**
 * The gate object meant to be threaded into every gated tool's
 * `requireConsent({ tg })`. Always constructed (even when
 * TG_APPROVAL_ENABLED=false) so callers never branch on its presence —
 * `enabledFor()` is simply false for every tool in that case.
 *
 * WIRED (as of the auto-execute-by-button pass, 2026-08-05): `consent.ts` has
 * the `tg?: TgApprovalGate` field on `RequireConsentParams` and the `if
 * (p.tg?.enabledFor(tool))` branches inside `requireConsent()`, mirroring
 * gmail-mcp's `consent.ts`. `tgApprovalGate` is wired into
 * `DriveConsentContext.tg` below, and every `drive`/`docs`/`skill_version`
 * write tool's `requireConsent(...)` call passes `tg: ctx.tg` (via
 * destructuring), so `TG_APPROVAL_ENABLED=true` does affect tool behaviour.
 */
export const tgApprovalGate: TgApprovalGate = createTgApprovalGate(tgApprovalConfig, tgApprovalStoreAdapter);

export function buildMcpServer(user: User): McpServer {
  const clients = buildUserClients(user);
  const accountsHint = clients.multi
    ? `Multiple Google accounts available: ${clients.names.join(", ")} (default: ${clients.defaultName}). Pass \`account\` to select.`
    : `One Google account ("${clients.defaultName}") is configured.`;

  const server = new McpServer(
    { name: "drive-mcp", version: "1.0.0" },
    { instructions: "Tools to organise Google Drive: search, upload, download, move, rename, trash files and folders. " + accountsHint },
  );
  // Honest degradation (gate.md §3.5): `consentStore`/`auditStore` are null
  // exactly when Postgres isn't configured — without it there's nowhere to
  // persist a manifest, so the gated write tools refuse outright rather than
  // mutate unconfirmed.
  const consentCtx: DriveConsentContext = {
    consentStore: storeReady() ? consentStoreAdapter : null,
    consentCfg: consentServerConfig,
    auditStore: storeReady() ? auditStoreAdapter : null,
    tg: tgApprovalGate,
  };
  registerAccountTools(server, clients);
  registerDriveTools(server, clients, consentCtx);
  registerDocsTools(server, clients, consentCtx);
  registerSkillVersionTools(server, clients, consentCtx);
  return server;
}
