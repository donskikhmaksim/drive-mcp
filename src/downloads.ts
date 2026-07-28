/**
 * Short-lived download links.
 *
 * Drive has no presigned-URL concept: `files.get?alt=media` always needs an
 * OAuth token, and handing that token to a phone or browser would give it the
 * whole account, not one file. `webContentLink` is no better — it only works
 * for someone already signed in as the owner, or for a file shared publicly.
 *
 * So this server mints its own capability URL instead: an unguessable token
 * that expires, stored server-side, redeemed at `GET /dl/<token>` where the
 * server streams the bytes. The link is the credential — anyone holding it can
 * fetch that one file until it expires, which is exactly the presigned-URL
 * trade-off, scoped to a single file and a short window.
 *
 * Tokens live in Postgres when one is configured, and in memory otherwise
 * (single-process env-credentials deployments), so links survive a restart on
 * the deployments that can actually have several instances.
 */
import { randomBytes } from "node:crypto";
import {
  storeReady,
  saveDownloadToken,
  getDownloadToken,
  type DownloadTarget,
} from "./store.js";

export type { DownloadTarget };

/** Public base URL of this server; set at startup. Links are impossible without it. */
let baseUrl: string | undefined;

/** Fallback store for deployments running without a database. */
const memory = new Map<string, DownloadTarget>();

export const DEFAULT_TTL_MINUTES = 60;
export const MAX_TTL_MINUTES = 24 * 60;

export function initDownloads(publicBaseUrl: string | undefined): void {
  baseUrl = publicBaseUrl?.replace(/\/+$/, "");
}

/** False when the server does not know its own public URL — no link can be built. */
export function downloadsAvailable(): boolean {
  return !!baseUrl;
}

/**
 * Mints a link for one file. `ttlMinutes` is clamped to MAX_TTL_MINUTES so a
 * caller cannot ask for a link that effectively never expires.
 */
export async function issueDownloadLink(
  target: Omit<DownloadTarget, "expiresAt">,
  ttlMinutes = DEFAULT_TTL_MINUTES,
): Promise<{ url: string; expiresAt: string }> {
  if (!baseUrl) {
    throw new Error(
      "This server does not know its public URL, so it cannot hand out download links. " +
        "Set PUBLIC_BASE_URL (Railway sets RAILWAY_PUBLIC_DOMAIN automatically once public networking is on).",
    );
  }
  const ttl = Math.min(Math.max(ttlMinutes, 1), MAX_TTL_MINUTES);
  const token = randomBytes(32).toString("base64url");
  const record: DownloadTarget = { ...target, expiresAt: Date.now() + ttl * 60_000 };

  if (storeReady()) {
    await saveDownloadToken(token, record);
  } else {
    for (const [k, v] of memory) if (v.expiresAt < Date.now()) memory.delete(k);
    memory.set(token, record);
  }
  return { url: `${baseUrl}/dl/${token}`, expiresAt: new Date(record.expiresAt).toISOString() };
}

/** Looks up a token. Returns null when unknown or expired. Links stay usable
 *  until they expire — one-shot links would break ordinary retries and resumes. */
export async function resolveDownloadLink(token: string): Promise<DownloadTarget | null> {
  if (storeReady()) return getDownloadToken(token);
  const rec = memory.get(token);
  if (!rec) return null;
  if (rec.expiresAt < Date.now()) {
    memory.delete(token);
    return null;
  }
  return rec;
}
