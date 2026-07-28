/**
 * Google Drive tools (search / organise files).
 * All mutating tools accept arrays of items and process them in parallel.
 */
import { z } from "zod";
import { Readable } from "node:stream";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ok, fail, guard, isTextual } from "../util.js";
import { accountField, type UserClients } from "../accounts.js";
import { documentToPlainText } from "./docs.js";

const GOOGLE_DOC_MIME = "application/vnd.google-apps.document";

/** Default export format for Google-native files when none is given. */
function defaultExportMime(mime: string): string {
  if (mime === "application/vnd.google-apps.document") return "text/plain";
  if (mime === "application/vnd.google-apps.spreadsheet") return "text/csv";
  return "application/pdf";
}

export function registerDriveTools(server: McpServer, clients: UserClients) {
  const account = accountField(clients);

  // ── Search (no change — already returns multiple) ──────────────────────────

  server.registerTool(
    "drive_search",
    {
      title: "Search Drive files",
      description:
        "Search files/folders in Drive. Either pass a raw Drive `query` (Drive API q syntax) or use `nameContains`/`mimeType` helpers.",
      inputSchema: {
        account,
        query: z
          .string()
          .optional()
          .describe("Raw Drive query, e.g. \"name contains 'report' and trashed=false\"."),
        nameContains: z.string().optional(),
        mimeType: z
          .string()
          .optional()
          .describe("e.g. application/vnd.google-apps.spreadsheet | .document | .folder"),
        maxResults: z.number().int().min(1).max(200).default(50).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    guard(async ({ account, query, nameContains, mimeType, maxResults }) => {
      const g = clients.resolve(account);
      let q = query;
      if (!q) {
        const parts = ["trashed=false"];
        if (nameContains) parts.push(`name contains '${nameContains.replace(/'/g, "\\'")}'`);
        if (mimeType) parts.push(`mimeType='${mimeType}'`);
        q = parts.join(" and ");
      }
      const res = await g.drive.files.list({
        q,
        pageSize: maxResults ?? 50,
        fields: "files(id,name,mimeType,modifiedTime,webViewLink,parents)",
        orderBy: "modifiedTime desc",
      });
      const files = res.data.files ?? [];
      const scopeDesc = nameContains ? `"${nameContains}"` : query ? `query: ${query}` : "all files";
      return ok({
        summary: `🔍 Drive search for ${scopeDesc}${mimeType ? ` (${mimeType})` : ""} — ${files.length} result(s)`,
        files,
      });
    }),
  );

  // ── Get metadata ───────────────────────────────────────────────────────────

  server.registerTool(
    "drive_get_metadata",
    {
      title: "Get file metadata",
      description: "Get metadata for one or more files by id.",
      inputSchema: {
        account,
        fileIds: z.array(z.string()).min(1).describe("Array of file IDs to fetch metadata for."),
      },
      annotations: { readOnlyHint: true },
    },
    guard(async ({ account, fileIds }) => {
      const g = clients.resolve(account);
      const results = await Promise.all(
        fileIds.map(async (fileId) => {
          try {
            const res = await g.drive.files.get({
              fileId,
              fields:
                "id,name,mimeType,modifiedTime,createdTime,size,owners(emailAddress),webViewLink,parents,trashed",
            });
            return { fileId, ...res.data };
          } catch (e: unknown) {
            return { fileId, error: e instanceof Error ? e.message : String(e) };
          }
        }),
      );
      return ok({
        summary: `ℹ️ Fetched metadata for ${fileIds.length} file(s)`,
        results,
      });
    }),
  );

  // ── Create folders ─────────────────────────────────────────────────────────

  server.registerTool(
    "drive_create_folder",
    {
      title: "Create folders",
      description: "Create one or more new folders, optionally inside parent folders.",
      inputSchema: {
        account,
        folders: z
          .array(z.object({ name: z.string(), parentId: z.string().optional() }))
          .min(1)
          .describe("Array of folders to create."),
      },
      annotations: { destructiveHint: false },
    },
    guard(async ({ account, folders }) => {
      const g = clients.resolve(account);
      const results = await Promise.all(
        folders.map(async ({ name, parentId }) => {
          try {
            const res = await g.drive.files.create({
              requestBody: {
                name,
                mimeType: "application/vnd.google-apps.folder",
                parents: parentId ? [parentId] : undefined,
              },
              fields: "id,name,webViewLink",
            });
            return { name: res.data.name ?? name, id: res.data.id, webViewLink: res.data.webViewLink };
          } catch (e: unknown) {
            return { name, error: e instanceof Error ? e.message : String(e) };
          }
        }),
      );
      return ok({
        summary: `📁 Created ${folders.length} folder(s)`,
        results,
      });
    }),
  );

  // ── Rename ─────────────────────────────────────────────────────────────────

  server.registerTool(
    "drive_rename",
    {
      title: "Rename files",
      description: "Rename one or more files or folders.",
      inputSchema: {
        account,
        items: z
          .array(z.object({ fileId: z.string(), newName: z.string() }))
          .min(1)
          .describe("Array of {fileId, newName} pairs."),
      },
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    guard(async ({ account, items }) => {
      const g = clients.resolve(account);
      const results = await Promise.all(
        items.map(async ({ fileId, newName }) => {
          try {
            await g.drive.files.update({
              fileId,
              requestBody: { name: newName },
              fields: "id,name",
            });
            return { fileId, newName };
          } catch (e: unknown) {
            return { fileId, newName, error: e instanceof Error ? e.message : String(e) };
          }
        }),
      );
      return ok({
        summary: `✏️ Renamed ${items.length} file(s)`,
        results,
      });
    }),
  );

  // ── Move ───────────────────────────────────────────────────────────────────

  server.registerTool(
    "drive_move",
    {
      title: "Move files",
      description: "Move one or more files into different folders.",
      inputSchema: {
        account,
        items: z
          .array(
            z.object({
              fileId: z.string(),
              newParentId: z.string().describe("Destination folder id."),
              removeParentId: z
                .string()
                .optional()
                .describe("Current parent folder id to detach from."),
            }),
          )
          .min(1)
          .describe("Array of {fileId, newParentId, removeParentId?} items."),
      },
      annotations: { destructiveHint: false },
    },
    guard(async ({ account, items }) => {
      const g = clients.resolve(account);
      const results = await Promise.all(
        items.map(async ({ fileId, newParentId, removeParentId }) => {
          try {
            const res = await g.drive.files.update({
              fileId,
              addParents: newParentId,
              removeParents: removeParentId,
              fields: "id,name,parents",
            });
            return { fileId, newParentId, name: res.data.name, parents: res.data.parents };
          } catch (e: unknown) {
            return { fileId, newParentId, error: e instanceof Error ? e.message : String(e) };
          }
        }),
      );
      return ok({
        summary: `📂 Moved ${items.length} file(s)`,
        results,
      });
    }),
  );

  // ── Trash ──────────────────────────────────────────────────────────────────

  server.registerTool(
    "drive_trash",
    {
      title: "Move files to trash",
      description:
        "Move one or more files to the trash (reversible). This does NOT permanently delete them.",
      inputSchema: {
        account,
        fileIds: z.array(z.string()).min(1).describe("Array of file IDs to trash."),
      },
      annotations: { destructiveHint: true },
    },
    guard(async ({ account, fileIds }) => {
      const g = clients.resolve(account);
      const results = await Promise.all(
        fileIds.map(async (fileId) => {
          try {
            await g.drive.files.update({
              fileId,
              requestBody: { trashed: true },
              fields: "id,name,trashed",
            });
            return { fileId, trashed: true as const };
          } catch (e: unknown) {
            return { fileId, error: e instanceof Error ? e.message : String(e) };
          }
        }),
      );
      return ok({
        summary: `🗑 Trashed ${fileIds.length} file(s)`,
        results,
      });
    }),
  );

  // ── Upload ─────────────────────────────────────────────────────────────────

  server.registerTool(
    "drive_upload_file",
    {
      title: "Upload / create new Drive files",
      description:
        "Create one or more new files in Drive from provided content. " +
        "Only suitable for SMALL files: the content travels inside the tool-call body " +
        "(practical limit ~1 MB). For larger files use drive_create_upload_session + " +
        "drive_confirm_upload, which lets the client PUT the bytes straight to Google. " +
        "To overwrite existing files use drive_overwrite_file instead. " +
        "Pass either `content_text` (UTF-8) or `content_base64` (binary) per file.",
      inputSchema: {
        account,
        files: z
          .array(
            z.object({
              name: z.string().describe("File name, e.g. 'report.pdf'."),
              mimeType: z
                .string()
                .optional()
                .describe("e.g. 'application/pdf', 'text/plain'. Default octet-stream."),
              parentId: z.string().optional().describe("Destination folder id."),
              content_text: z.string().optional(),
              content_base64: z.string().optional(),
            }),
          )
          .min(1)
          .describe("Array of files to upload."),
      },
      annotations: { destructiveHint: false },
    },
    guard(async ({ account, files }) => {
      const g = clients.resolve(account);
      const results = await Promise.all(
        files.map(async ({ name, mimeType, parentId, content_text, content_base64 }) => {
          try {
            if (!content_text && !content_base64) {
              return { name, error: "Provide either content_text or content_base64." };
            }
            const buffer = content_base64
              ? Buffer.from(content_base64, "base64")
              : Buffer.from(content_text ?? "", "utf8");
            const mediaMimeType = mimeType ?? "application/octet-stream";
            const res = await g.drive.files.create({
              requestBody: { name, parents: parentId ? [parentId] : undefined },
              media: { mimeType: mediaMimeType, body: Readable.from(buffer) },
              fields: "id,name,webViewLink",
            });
            return { name: res.data.name ?? name, id: res.data.id, webViewLink: res.data.webViewLink };
          } catch (e: unknown) {
            return { name, error: e instanceof Error ? e.message : String(e) };
          }
        }),
      );
      return ok({
        summary: `⬆️ Uploaded ${files.length} file(s)`,
        results,
      });
    }),
  );

  // ── Resumable upload: create session ──────────────────────────────────────

  server.registerTool(
    "drive_create_upload_session",
    {
      title: "Create resumable upload sessions (large files)",
      description:
        "Start one or more Google Drive resumable uploads and return a temporary upload URL " +
        "(resumable session URI) per file. The CLIENT then PUTs the raw file bytes directly to " +
        "that URL — the server never proxies the file, so nothing large travels through the " +
        "tool-call body. Use this for files bigger than ~1 MB, where drive_upload_file is not " +
        "usable (there the whole content is sent as base64 inside the call). Each session URI " +
        "stays valid for up to ~1 week. After the bytes are uploaded, call drive_confirm_upload " +
        "with the same uploadUrl to check status and get the final fileId.",
      inputSchema: {
        account,
        files: z
          .array(
            z.object({
              name: z.string().describe("File name, e.g. 'video.mp4'."),
              mimeType: z
                .string()
                .optional()
                .describe("Content type of the bytes the client will upload. Default octet-stream."),
              fileSize: z
                .number()
                .int()
                .positive()
                .optional()
                .describe("Total size in bytes, if known. Lets Google validate the upload."),
              parentId: z.string().optional().describe("Destination folder id."),
            }),
          )
          .min(1)
          .describe("Array of files to create upload sessions for."),
      },
      annotations: { destructiveHint: false },
    },
    guard(async ({ account, files }) => {
      const g = clients.resolve(account);
      const token = await g.accessToken();
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
      const results = await Promise.all(
        files.map(async ({ name, mimeType, fileSize, parentId }) => {
          try {
            const res = await fetch(
              "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true",
              {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${token}`,
                  "Content-Type": "application/json; charset=UTF-8",
                  "X-Upload-Content-Type": mimeType ?? "application/octet-stream",
                  ...(fileSize ? { "X-Upload-Content-Length": String(fileSize) } : {}),
                },
                body: JSON.stringify({
                  name,
                  parents: parentId ? [parentId] : undefined,
                }),
              },
            );
            if (!res.ok) {
              return { name, error: `Google returned ${res.status}: ${await res.text()}` };
            }
            const uploadUrl = res.headers.get("location");
            if (!uploadUrl) {
              return {
                name,
                error: "Google did not return a resumable session URI (no Location header).",
              };
            }
            return {
              name,
              uploadUrl,
              mimeType: mimeType ?? "application/octet-stream",
              fileSize: fileSize ?? null,
              expiresAt,
            };
          } catch (e: unknown) {
            return { name, error: e instanceof Error ? e.message : String(e) };
          }
        }),
      );
      return ok({
        summary:
          `⬆️ Created ${files.length} resumable upload session(s). ` +
          "Client must PUT the raw file bytes to uploadUrl " +
          "(headers: Content-Length: <size>, Content-Type: <mimeType>), " +
          "then call drive_confirm_upload.",
        results,
      });
    }),
  );

  // ── Resumable upload: confirm / check status ──────────────────────────────

  server.registerTool(
    "drive_confirm_upload",
    {
      title: "Check / confirm a resumable upload",
      description:
        "Query the status of one or more resumable upload sessions created by " +
        "drive_create_upload_session. If the upload finished, returns the final fileId together " +
        "with the file name and webViewLink. If it is still incomplete, reports how many bytes " +
        "Google has already accepted so the client can resume from that offset.",
      inputSchema: {
        account,
        sessions: z
          .array(
            z.object({
              uploadUrl: z
                .string()
                .describe("The resumable session URI returned by drive_create_upload_session."),
              fileSize: z
                .number()
                .int()
                .positive()
                .optional()
                .describe("Total size in bytes, if known — improves the status check."),
            }),
          )
          .min(1)
          .describe("Array of upload sessions to check."),
      },
      annotations: { readOnlyHint: true },
    },
    guard(async ({ account, sessions }) => {
      const g = clients.resolve(account);
      const results = await Promise.all(
        sessions.map(async ({ uploadUrl, fileSize }) => {
          try {
            // A zero-length PUT with "bytes */<total>" asks Google for the current status;
            // the session URI itself carries the upload_id, so no Authorization is needed.
            const res = await fetch(uploadUrl, {
              method: "PUT",
              headers: {
                "Content-Range": `bytes */${fileSize ?? "*"}`,
                "Content-Length": "0",
              },
            });

            if (res.status === 200 || res.status === 201) {
              let fileId: string | null = null;
              let name: string | null = null;
              let mimeType: string | null = null;
              try {
                const body = (await res.json()) as {
                  id?: string;
                  name?: string;
                  mimeType?: string;
                };
                fileId = body.id ?? null;
                name = body.name ?? null;
                mimeType = body.mimeType ?? null;
              } catch {
                /* body may be empty — fall back to metadata below */
              }
              let size: string | null = null;
              let webViewLink: string | null = null;
              if (fileId) {
                try {
                  const meta = await g.drive.files.get({
                    fileId,
                    fields: "id,name,mimeType,size,webViewLink",
                  });
                  name = meta.data.name ?? name;
                  mimeType = meta.data.mimeType ?? mimeType;
                  size = meta.data.size ?? null;
                  webViewLink = meta.data.webViewLink ?? null;
                } catch {
                  /* metadata lookup is best-effort — return what we already have */
                }
              }
              return {
                uploadUrl,
                status: "completed" as const,
                fileId,
                name,
                mimeType,
                size,
                webViewLink,
              };
            }

            if (res.status === 308) {
              // "Resume Incomplete": Range: bytes=0-N tells how much Google stored.
              const range = res.headers.get("range");
              const end = range ? Number(range.split("-")[1]) : NaN;
              const bytesReceived = Number.isFinite(end) ? end + 1 : 0;
              return {
                uploadUrl,
                status: "incomplete" as const,
                bytesReceived,
                nextOffset: bytesReceived,
                hint:
                  "Client should PUT the remaining bytes with " +
                  "Content-Range: bytes <nextOffset>-<end>/<total>.",
              };
            }

            if (res.status === 404 || res.status === 410) {
              return {
                uploadUrl,
                status: "expired" as const,
                error:
                  "Upload session is gone (expired or already finalised). Create a new session.",
              };
            }

            return { uploadUrl, error: `Google returned ${res.status}: ${await res.text()}` };
          } catch (e: unknown) {
            return { uploadUrl, error: e instanceof Error ? e.message : String(e) };
          }
        }),
      );
      return ok({
        summary: `🔎 Checked ${sessions.length} resumable upload session(s)`,
        results,
      });
    }),
  );

  // ── Overwrite ──────────────────────────────────────────────────────────────

  server.registerTool(
    "drive_overwrite_file",
    {
      title: "Overwrite existing Drive files",
      description:
        "Replace the content of one or more existing Drive files by their ids. " +
        "This is destructive — the previous content is lost (unless versioned first). " +
        "Pass either `content_text` (UTF-8) or `content_base64` (binary) per file.",
      inputSchema: {
        account,
        files: z
          .array(
            z.object({
              fileId: z.string().describe("Id of the file to overwrite."),
              mimeType: z.string().optional().describe("e.g. 'application/pdf', 'text/plain'."),
              content_text: z.string().optional(),
              content_base64: z.string().optional(),
            }),
          )
          .min(1)
          .describe("Array of files to overwrite."),
      },
      annotations: { destructiveHint: true },
    },
    guard(async ({ account, files }) => {
      const g = clients.resolve(account);
      const results = await Promise.all(
        files.map(async ({ fileId, mimeType, content_text, content_base64 }) => {
          try {
            if (!content_text && !content_base64) {
              return { fileId, error: "Provide either content_text or content_base64." };
            }
            const buffer = content_base64
              ? Buffer.from(content_base64, "base64")
              : Buffer.from(content_text ?? "", "utf8");
            const mediaMimeType = mimeType ?? "application/octet-stream";
            const res = await g.drive.files.update({
              fileId,
              requestBody: {},
              media: { mimeType: mediaMimeType, body: Readable.from(buffer) },
              fields: "id,name",
            });
            return { fileId, name: res.data.name ?? null };
          } catch (e: unknown) {
            return { fileId, error: e instanceof Error ? e.message : String(e) };
          }
        }),
      );
      return ok({
        summary: `♻️ Overwrote ${files.length} file(s)`,
        results,
      });
    }),
  );

  // ── Download ───────────────────────────────────────────────────────────────

  server.registerTool(
    "drive_download_file",
    {
      title: "Download / read Drive files",
      description:
        "Read one or more Drive files' content. Text files are returned as text; Google Docs/Sheets/Slides are exported " +
        "(default: doc→text, sheet→csv, else pdf); other binaries are returned as base64 (size-limited).",
      inputSchema: {
        account,
        files: z
          .array(
            z.object({
              fileId: z.string(),
              exportMimeType: z
                .string()
                .optional()
                .describe("Override export format for Google-native files, e.g. 'application/pdf'."),
            }),
          )
          .min(1)
          .describe("Array of files to download."),
        maxBytes: z
          .number()
          .int()
          .min(1)
          .max(8_000_000)
          .default(750_000)
          .optional()
          .describe("Max bytes to inline for binary content (base64). Default ~0.75MB."),
      },
      annotations: { readOnlyHint: true },
    },
    guard(async ({ account, files, maxBytes }) => {
      const g = clients.resolve(account);
      const limit = maxBytes ?? 750_000;
      const results = await Promise.all(
        files.map(async ({ fileId, exportMimeType }) => {
          try {
            const meta = await g.drive.files.get({ fileId, fields: "id,name,mimeType,size" });
            const mime = meta.data.mimeType ?? "";
            let buf: Buffer;
            let outMime: string;
            if (mime.startsWith("application/vnd.google-apps.")) {
              outMime = exportMimeType ?? defaultExportMime(mime);
              const res = await g.drive.files.export(
                { fileId, mimeType: outMime },
                { responseType: "arraybuffer" },
              );
              buf = Buffer.from(res.data as ArrayBuffer);
            } else {
              outMime = mime;
              const res = await g.drive.files.get(
                { fileId, alt: "media" },
                { responseType: "arraybuffer" },
              );
              buf = Buffer.from(res.data as ArrayBuffer);
            }
            if (isTextual(outMime)) {
              return {
                fileId,
                name: meta.data.name ?? null,
                mimeType: outMime,
                content: buf.toString("utf8"),
                encoding: "text" as const,
              };
            }
            if (buf.length > limit) {
              return {
                fileId,
                error: `File is ${buf.length} bytes (binary) — too large to inline. Raise maxBytes (max 8MB).`,
              };
            }
            return {
              fileId,
              name: meta.data.name ?? null,
              mimeType: outMime,
              content: buf.toString("base64"),
              encoding: "base64" as const,
            };
          } catch (e: unknown) {
            return { fileId, error: e instanceof Error ? e.message : String(e) };
          }
        }),
      );
      return ok({
        summary: `⬇️ Downloaded ${files.length} file(s)`,
        results,
      });
    }),
  );

  // ── Extract text (OCR) ─────────────────────────────────────────────────────

  server.registerTool(
    "drive_extract_text",
    {
      title: "Extract text from PDFs/images (OCR)",
      description:
        "Extract text from one or more Drive files (PDF, scan, or image) using Google Drive's built-in OCR. " +
        "Converts each to a temporary Google Doc, reads the text, and cleans up.",
      inputSchema: {
        account,
        fileIds: z.array(z.string()).min(1).describe("Array of Drive file IDs (PDFs/images)."),
        ocrLanguage: z
          .string()
          .optional()
          .describe("Optional language hint, e.g. 'en', 'ru'. Improves OCR accuracy."),
      },
      annotations: { destructiveHint: false },
    },
    guard(async ({ account, fileIds, ocrLanguage }) => {
      const g = clients.resolve(account);
      const results = await Promise.all(
        fileIds.map(async (fileId) => {
          let docId: string | null = null;
          try {
            const copy = await g.drive.files.copy({
              fileId,
              ocrLanguage,
              requestBody: { name: "gmcp-ocr-tmp", mimeType: GOOGLE_DOC_MIME },
              fields: "id",
            });
            docId = copy.data.id!;
            const doc = await g.docs.documents.get({ documentId: docId });
            const text = documentToPlainText(doc.data);
            return { fileId, text };
          } catch (e: unknown) {
            return { fileId, error: e instanceof Error ? e.message : String(e) };
          } finally {
            if (docId) {
              await g.drive.files.delete({ fileId: docId }).catch(() => {});
            }
          }
        }),
      );
      return ok({
        summary: `📄 Extracted text from ${fileIds.length} file(s) via OCR`,
        results,
      });
    }),
  );

  // ── Permissions ───────────────────────────────────────────────────────────

  server.registerTool(
    "drive_get_permissions",
    {
      title: "Get file permissions",
      description: "List all sharing permissions (who has access) for one or more Drive files or folders.",
      inputSchema: {
        account,
        fileIds: z.array(z.string()).min(1).describe("Array of file or folder IDs."),
      },
      annotations: { readOnlyHint: true },
    },
    guard(async ({ account, fileIds }) => {
      const g = clients.resolve(account);
      const results = await Promise.all(
        fileIds.map(async (fileId) => {
          try {
            const res = await g.drive.permissions.list({
              fileId,
              fields: "permissions(id,type,role,emailAddress,displayName,domain,expirationTime)",
            });
            return { fileId, permissions: res.data.permissions ?? [] };
          } catch (e: unknown) {
            return { fileId, error: e instanceof Error ? e.message : String(e) };
          }
        }),
      );
      return ok({
        summary: `🔐 Fetched permissions for ${fileIds.length} file(s)`,
        results,
      });
    }),
  );

  server.registerTool(
    "drive_share",
    {
      title: "Share files / set permissions",
      description:
        "Share one or more Drive files or folders with users, groups, domains, or make them public. " +
        "Use role='reader'|'commenter'|'writer'|'fileOrganizer'|'organizer'|'owner'. " +
        "Set sendNotificationEmail=false to share silently.",
      inputSchema: {
        account,
        items: z
          .array(
            z.object({
              fileId: z.string().describe("File or folder ID."),
              role: z
                .enum(["reader", "commenter", "writer", "fileOrganizer", "organizer", "owner"])
                .describe("Access level to grant."),
              type: z
                .enum(["user", "group", "domain", "anyone"])
                .describe("Who to grant access to."),
              emailAddress: z
                .string()
                .optional()
                .describe("Email of the user or group (required when type=user or group)."),
              domain: z
                .string()
                .optional()
                .describe("Domain name (required when type=domain, e.g. 'example.com')."),
              sendNotificationEmail: z
                .boolean()
                .default(false)
                .optional()
                .describe("Send email notification to the recipient (default: false)."),
              emailMessage: z
                .string()
                .optional()
                .describe("Custom message to include in the notification email."),
              transferOwnership: z
                .boolean()
                .default(false)
                .optional()
                .describe("Transfer ownership (only for role=owner, same domain)."),
            }),
          )
          .min(1)
          .describe("Array of share operations."),
      },
    },
    guard(async ({ account, items }) => {
      const g = clients.resolve(account);
      const results = await Promise.all(
        items.map(
          async ({
            fileId,
            role,
            type,
            emailAddress,
            domain,
            sendNotificationEmail,
            emailMessage,
            transferOwnership,
          }) => {
            try {
              if ((type === "user" || type === "group") && !emailAddress) {
                return { fileId, error: `emailAddress is required when type="${type}".` };
              }
              if (type === "domain" && !domain) {
                return { fileId, error: `domain is required when type="domain".` };
              }
              const res = await g.drive.permissions.create({
                fileId,
                sendNotificationEmail: sendNotificationEmail ?? false,
                emailMessage,
                transferOwnership: transferOwnership ?? false,
                requestBody: { role, type, emailAddress, domain },
                fields: "id,role,type,emailAddress",
              });
              return {
                fileId,
                permissionId: res.data.id,
                role: res.data.role,
                type: res.data.type,
                emailAddress: res.data.emailAddress,
              };
            } catch (e: unknown) {
              return { fileId, error: e instanceof Error ? e.message : String(e) };
            }
          },
        ),
      );
      return ok({
        summary: `✅ Processed ${items.length} share operation(s)`,
        results,
      });
    }),
  );

  server.registerTool(
    "drive_unshare",
    {
      title: "Remove permissions",
      description:
        "Remove sharing permissions from Drive files or folders. Use drive_get_permissions to find the permissionIds.",
      inputSchema: {
        account,
        items: z
          .array(
            z.object({
              fileId: z.string().describe("File or folder ID."),
              permissionId: z.string().describe("Permission ID to remove."),
            }),
          )
          .min(1)
          .describe("Array of {fileId, permissionId} pairs."),
      },
    },
    guard(async ({ account, items }) => {
      const g = clients.resolve(account);
      const results = await Promise.all(
        items.map(async ({ fileId, permissionId }) => {
          try {
            await g.drive.permissions.delete({ fileId, permissionId });
            return { fileId, permissionId };
          } catch (e: unknown) {
            return { fileId, permissionId, error: e instanceof Error ? e.message : String(e) };
          }
        }),
      );
      return ok({
        summary: `🔒 Removed ${items.length} permission(s)`,
        results,
      });
    }),
  );
}
