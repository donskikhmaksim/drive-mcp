#!/usr/bin/env node
/**
 * Offline checks for the two-storage credential model added on top of the
 * legacy MCP_AUTH_TOKEN path:
 *   1. selectAccountsForLegacyToken / isAccountLinkAllowed — pure decision
 *      functions from src/credentialSource.ts, exercised directly with
 *      hand-built User/email inputs (no Postgres, no Google — nothing to mock).
 *   2. loadConfig() — env-var parsing in src/config.ts, exercised by setting
 *      process.env before each call and restoring it after. Covers the
 *      onboarding-enabled-but-no-env-creds token-holder fallback.
 *
 * Usage:
 *   npm test                                # builds, then runs this
 *   node scripts/test-credential-source.mjs
 */
import { selectAccountsForLegacyToken, isAccountLinkAllowed } from "../dist/credentialSource.js";
import { loadConfig } from "../dist/config.js";

let failures = 0;
const check = (label, cond, extra = "") => {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${label}${cond ? "" : ` — got: ${extra}`}`);
  if (!cond) failures++;
};

// --- selectAccountsForLegacyToken -------------------------------------------

console.log("\n[1] selectAccountsForLegacyToken");

const legacy = { name: "default", token: "tok", accounts: [{ name: "env", auth: {} }], defaultAccount: "env" };
const onboarded = { name: "me@x.com", accounts: [{ name: "personal", auth: {} }], defaultAccount: "personal" };
const emptyLegacy = { name: "default", token: "tok", accounts: [], defaultAccount: "" };

check(
  "no token match → null regardless of onboarding",
  selectAccountsForLegacyToken(null, onboarded) === null,
);
check(
  "Postgres has accounts → prefers onboarded over env",
  selectAccountsForLegacyToken(legacy, onboarded) === onboarded,
);
check(
  "Postgres empty (null) → falls back to env accounts",
  selectAccountsForLegacyToken(legacy, null) === legacy,
);
check(
  "token holder with no env accounts + Postgres has accounts → onboarded",
  selectAccountsForLegacyToken(emptyLegacy, onboarded) === onboarded,
);
check(
  "token holder with no env accounts + Postgres empty → the (empty) holder itself, not null",
  selectAccountsForLegacyToken(emptyLegacy, null) === emptyLegacy,
);

// --- isAccountLinkAllowed ----------------------------------------------------

console.log("\n[2] isAccountLinkAllowed");

check(
  "no allowlist configured → any new account allowed (fail-open)",
  isAccountLinkAllowed("stranger@gmail.com", undefined, false) === true,
);
check(
  "empty allowlist array → any new account allowed (fail-open)",
  isAccountLinkAllowed("stranger@gmail.com", [], false) === true,
);
check(
  "allowlist set, email is on it → allowed",
  isAccountLinkAllowed("owner@gmail.com", ["owner@gmail.com"], false) === true,
);
check(
  "allowlist set, email NOT on it, brand new account → blocked",
  isAccountLinkAllowed("stranger@gmail.com", ["owner@gmail.com"], false) === false,
);
check(
  "allowlist set, email NOT on it, but ALREADY linked (re-consent) → allowed",
  isAccountLinkAllowed("stranger@gmail.com", ["owner@gmail.com"], true) === true,
);
check(
  "allowlist comparison ignores case (config lowercases; email echoed back is compared lowercased)",
  isAccountLinkAllowed("Owner@Gmail.com".toLowerCase(), ["owner@gmail.com"], false) === true,
);

// --- loadConfig(): OWNER_EMAILS parsing -------------------------------------

console.log("\n[3] loadConfig(): OWNER_EMAILS parsing");

const ENV_KEYS = [
  "MCP_TRANSPORT", "PORT", "DATABASE_URL", "PUBLIC_BASE_URL", "RAILWAY_PUBLIC_DOMAIN",
  "ONBOARDING_GOOGLE_CLIENT_ID", "ONBOARDING_GOOGLE_CLIENT_SECRET",
  "GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET", "GOOGLE_OAUTH_REFRESH_TOKEN",
  "GOOGLE_SERVICE_ACCOUNT_JSON", "GOOGLE_SERVICE_ACCOUNT_BASE64", "GOOGLE_ACCOUNTS",
  "GOOGLE_DEFAULT_ACCOUNT", "GMAIL_DEFAULT_QUERY", "TOKEN_ENC_KEY", "OAUTH_RELAY_URL",
  "OAUTH_RELAY_SECRET", "DASHBOARD_SECRET", "OWNER_EMAILS", "MCP_AUTH_TOKEN", "MCP_USERS",
];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const resetEnv = () => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
};
const clearEnv = () => {
  for (const k of ENV_KEYS) delete process.env[k];
};

try {
  // 3a. Onboarding fully configured, no env Google creds, MCP_AUTH_TOKEN set:
  //     must NOT throw, and must produce a token-holder user with 0 accounts
  //     (so handleMcp can fill it in from Postgres per-request).
  clearEnv();
  process.env.DATABASE_URL = "postgres://x/y";
  process.env.PUBLIC_BASE_URL = "https://app.example.com";
  process.env.ONBOARDING_GOOGLE_CLIENT_ID = "cid";
  process.env.ONBOARDING_GOOGLE_CLIENT_SECRET = "csecret";
  process.env.TOKEN_ENC_KEY = "enckey";
  process.env.MCP_AUTH_TOKEN = "static-token-123";

  const cfg = loadConfig();
  check("onboarding reports enabled", cfg.onboarding.enabled === true);
  check("does not throw despite missing env Google creds", true);
  check("produces exactly one token-holder user", cfg.users.length === 1, String(cfg.users.length));
  check("token holder carries the static token", cfg.users[0]?.token === "static-token-123", cfg.users[0]?.token);
  check("token holder starts with zero accounts (filled from Postgres per-request)", cfg.users[0]?.accounts.length === 0, String(cfg.users[0]?.accounts.length));
  check("requireAuth is on", cfg.requireAuth === true);

  // 3b. Same, but no MCP_AUTH_TOKEN at all → no phantom user, users stays empty
  //     (matches pre-existing behaviour for the "OAuth-only, no static token" case).
  delete process.env.MCP_AUTH_TOKEN;
  const cfg2 = loadConfig();
  check("no MCP_AUTH_TOKEN → users list stays empty", cfg2.users.length === 0, String(cfg2.users.length));

  // 3c. OWNER_EMAILS parsing: trimmed, lowercased, empty entries dropped.
  process.env.OWNER_EMAILS = " Owner@Example.com ,, second@EXAMPLE.com";
  const cfg3 = loadConfig();
  check(
    "OWNER_EMAILS parsed, trimmed, lowercased, blanks dropped",
    JSON.stringify(cfg3.onboarding.ownerEmails) === JSON.stringify(["owner@example.com", "second@example.com"]),
    JSON.stringify(cfg3.onboarding.ownerEmails),
  );

  delete process.env.OWNER_EMAILS;
  const cfg4 = loadConfig();
  check("OWNER_EMAILS unset → ownerEmails is undefined (feature off)", cfg4.onboarding.ownerEmails === undefined);

  // 3d. Onboarding disabled + no env creds + no MCP_USERS → still throws
  //     (unchanged pre-existing behaviour; only the onboarding-enabled path
  //     was relaxed).
  clearEnv();
  let threw = false;
  try {
    loadConfig();
  } catch {
    threw = true;
  }
  check("onboarding disabled, no creds anywhere → loadConfig() still throws", threw === true);
} finally {
  resetEnv();
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
