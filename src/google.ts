import { google, docs_v1, drive_v3 } from "googleapis";
import { GoogleAuthConfig } from "./config.js";

const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/documents.readonly",
];

export interface GoogleClients {
  docs: docs_v1.Docs;
  drive: drive_v3.Drive;
  /**
   * A fresh OAuth access token for raw HTTP calls that bypass the googleapis
   * client (e.g. Drive resumable uploads). Works for both auth modes.
   */
  accessToken(): Promise<string>;
}

function buildAuthClient(auth: GoogleAuthConfig) {
  if (auth.mode === "oauth") {
    const oauth2 = new google.auth.OAuth2(auth.clientId, auth.clientSecret);
    oauth2.setCredentials({ refresh_token: auth.refreshToken });
    return oauth2;
  }
  return new google.auth.GoogleAuth({
    credentials: auth.credentials as Record<string, string>,
    scopes: GOOGLE_SCOPES,
  });
}

export function createGoogleClients(authConfig: GoogleAuthConfig): GoogleClients {
  const auth = buildAuthClient(authConfig);

  // OAuth2Client resolves to `{ token }`, GoogleAuth resolves to a plain string.
  async function accessToken(): Promise<string> {
    const t: string | { token?: string | null } | null | undefined =
      await auth.getAccessToken();
    const token = typeof t === "string" ? t : t?.token;
    if (!token) throw new Error("Failed to obtain a Google access token.");
    return token;
  }

  return {
    docs: google.docs({ version: "v1", auth }),
    drive: google.drive({ version: "v3", auth }),
    accessToken,
  };
}
