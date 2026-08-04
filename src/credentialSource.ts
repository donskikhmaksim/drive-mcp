/**
 * Pure decision functions for "which Google credentials serve this request /
 * this new account link". Kept dependency-free (no express, pg, googleapis)
 * so they can be unit-tested without mocking those.
 */
import type { User } from "./config.js";

/**
 * Chooses which `User` (and thus which Google accounts) serves a request that
 * authenticated via the static `MCP_AUTH_TOKEN` (legacy bearer / `x-api-key` /
 * `?key=` auth) — as opposed to a native per-caller OAuth session.
 *
 * The onboarding database (Postgres, via `getGoogleAccounts`) is the live
 * source of truth once it holds anything: env accounts (`GOOGLE_ACCOUNTS` /
 * `GOOGLE_OAUTH_*`) predate self-service onboarding and only exist as a
 * fallback for deployments where nobody has onboarded yet, or self-hosted
 * forks that never turn onboarding on.
 *
 * @param legacyUser   The user matched purely by comparing the static token
 *                     against configured env users (or `null` if no token
 *                     matched — caller should treat that as unauthenticated).
 * @param onboardedUser The user rebuilt from Postgres-linked Google accounts
 *                     (via `userFromGoogleAccounts`), or `null` when
 *                     onboarding is disabled or the database has no accounts
 *                     linked yet.
 */
export function selectAccountsForLegacyToken(
  legacyUser: User | null,
  onboardedUser: User | null,
): User | null {
  if (!legacyUser) return null;
  return onboardedUser ?? legacyUser;
}

/**
 * Decides whether a Google account may be newly linked to this instance
 * through onboarding (the MCP client connect flow, or the dashboard's "add
 * another account"). Already-linked accounts (re-consent, token refresh) are
 * always allowed — this only gates accounts nobody has seen on this instance
 * before. An empty/undefined allowlist means the feature is off: fail-open,
 * so deployments that never set `OWNER_EMAILS` keep today's behaviour.
 */
export function isAccountLinkAllowed(
  email: string,
  ownerEmails: string[] | undefined,
  alreadyLinked: boolean,
): boolean {
  if (alreadyLinked) return true;
  if (!ownerEmails || ownerEmails.length === 0) return true;
  return ownerEmails.includes(email.trim().toLowerCase());
}
