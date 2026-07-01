/**
 * Google Drive tools (search / organise files).
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

  server.registerTool(
    "drive_get_metadata",
    {
      title: "Get file metadata",
      description: "Get metadata for a single file by id.",
      inputSchema: { account, fileId: z.string() },
      annotations: { readOnlyHint: true },
    },
    guard(async ({ account, fileId }) => {
      const g = clients.resolve(account);
      const res = await g.drive.files.get({
        fileId,
        fields:
          "id,name,mimeType,modifiedTime,createdTime,size,owners(emailAddress),webViewLink,parents,trashed",
      });
      const owner = res.data.owners?.[0]?.emailAddress;
      return ok({
        summary: `ℹ️ "${res.data.name ?? fileId}" — ${res.data.mimeType ?? "?"}${owner ? ` · owner ${owner}` : ""}${res.data.trashed ? " · TRASHED" : ""}`,
        ...res.data,
      });
    }),
  );

  server.registerTool(
    "drive_create_folder",
    {
      title: "Create folder",
      description: "Create a new folder, optionally inside a parent folder.",
      inputSchema: {
        account,
        name: z.string(),
        parentId: z.string().optional(),
      },
      annotations: { destructiveHint: false },
    },
    guard(async ({ account, name, parentId }) => {
      const g = clients.resolve(account);
      const res = await g.drive.files.create({
        requestBody: {
          name,
          mimeType: "application/vnd.google-apps.folder",
          parents: parentId ? [parentId] : undefined,
        },
        fields: "id,name,webViewLink",
      });
      return ok({
        summary: `📁 Created folder "${res.data.name ?? name}"`,
        id: res.data.id,
        name: res.data.name,
        webViewLink: res.data.webViewLink,
      });
    }),
  );

  server.registerTool(
    "drive_rename",
    {
      title: "Rename file",
      description: "Rename a file or folder.",
      inputSchema: {
        account,
        fileId: z.string(),
        _fileName: z.string().optional().describe("Current file name (for the approval dialog — fill from context if known)."),
        newName: z.string(),
      },
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    guard(async ({ account, fileId, newName }) => {
      const g = clients.resolve(account);
      let oldName: string | null = null;
      try {
        const meta = await g.drive.files.get({ fileId, fields: "name" });
        oldName = meta.data.name ?? null;
      } catch {}
      const res = await g.drive.files.update({
        fileId,
        requestBody: { name: newName },
        fields: "id,name",
      });
      return ok({
        summary: oldName
          ? `✏️ Renamed "${oldName}" → "${newName}"`
          : `✏️ Renamed file → "${newName}"`,
        oldName,
        id: res.data.id,
        name: res.data.name,
      });
    }),
  );

  server.registerTool(
    "drive_move",
    {
      title: "Move file",
      description: "Move a file into a different folder.",
      inputSchema: {
        account,
        fileId: z.string(),
        _fileName: z.string().optional().describe("File name (for the approval dialog — fill from context if known)."),
        addParentId: z.string().describe("Destination folder id."),
        removeParentId: z
          .string()
          .optional()
          .describe("Current parent folder id to detach from."),
      },
      annotations: { destructiveHint: false },
    },
    guard(async ({ account, fileId, addParentId, removeParentId }) => {
      const g = clients.resolve(account);
      let fileName: string | null = null;
      try {
        const meta = await g.drive.files.get({ fileId, fields: "name" });
        fileName = meta.data.name ?? null;
      } catch {}
      const res = await g.drive.files.update({
        fileId,
        addParents: addParentId,
        removeParents: removeParentId,
        fields: "id,name,parents",
      });
      return ok({
        summary: fileName
          ? `📂 Moved "${fileName}" → folder ${addParentId}`
          : `📂 Moved file ${fileId} → folder ${addParentId}`,
        id: res.data.id,
        name: res.data.name,
        parents: res.data.parents,
      });
    }),
  );

  server.registerTool(
    "drive_trash",
    {
      title: "Move file to trash",
      description:
        "Move a file to the trash (reversible). This does NOT permanently delete it. " +
        "Returns the file's name/type/owner so it's clear what was trashed. " +
        "Pass `_fileName` if already known — it appears in the approval dialog.",
      inputSchema: {
        account,
        fileId: z.string(),
        _fileName: z.string().optional().describe("File name (for the approval dialog — fill from context if known)."),
      },
      annotations: { destructiveHint: true },
    },
    guard(async ({ account, fileId, _fileName }) => {
      const g = clients.resolve(account);
      let before: { name?: string | null; mimeType?: string | null; modifiedTime?: string | null; owners?: { emailAddress?: string | null }[] } | null =
        _fileName ? { name: _fileName } : null;
      try {
        const meta = await g.drive.files.get({
          fileId,
          fields: "id,name,mimeType,modifiedTime,size,owners(emailAddress),webViewLink",
        });
        before = meta.data;
      } catch {
        // If the read fails, still proceed with the trash.
      }
      const res = await g.drive.files.update({
        fileId,
        requestBody: { trashed: true },
        fields: "id,name,trashed",
      });
      const owner = before?.owners?.[0]?.emailAddress;
      return ok({
        summary: before
          ? `🗑 Trashed file — "${before.name}"${before.mimeType ? ` (${before.mimeType})` : ""}${owner ? ` · owner ${owner}` : ""}`
          : `🗑 Trashed file ${fileId}`,
        name: before?.name ?? res.data.name ?? null,
        mimeType: before?.mimeType ?? null,
        modifiedTime: before?.modifiedTime ?? null,
        id: res.data.id,
        trashed: res.data.trashed,
        trashedFile: before,
      });
    }),
  );

  server.registerTool(
    "drive_download_file",
    {
      title: "Download / read a Drive file",
      description:
        "Read a Drive file's content. Text files are returned as text; Google Docs/Sheets/Slides are exported " +
        "(default: doc→text, sheet→csv, else pdf); other binaries are returned as base64 (size-limited). " +
        "For large/binary files prefer keeping them in Drive.",
      inputSchema: {
        account,
        fileId: z.string(),
        exportMimeType: z
          .string()
          .optional()
          .describe("Override export format for Google-native files, e.g. 'application/pdf', 'text/csv'."),
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
    guard(async ({ account, fileId, exportMimeType, maxBytes }) => {
      const g = clients.resolve(account);
      const meta = await g.drive.files.get({ fileId, fields: "id,name,mimeType,size" });
      const mime = meta.data.mimeType ?? "";
      let buf: Buffer;
      let outMime: string;
      let exported = false;
      if (mime.startsWith("application/vnd.google-apps.")) {
        outMime = exportMimeType ?? defaultExportMime(mime);
        const res = await g.drive.files.export(
          { fileId, mimeType: outMime },
          { responseType: "arraybuffer" },
        );
        buf = Buffer.from(res.data as ArrayBuffer);
        exported = true;
      } else {
        outMime = mime;
        const res = await g.drive.files.get(
          { fileId, alt: "media" },
          { responseType: "arraybuffer" },
        );
        buf = Buffer.from(res.data as ArrayBuffer);
      }
      const base = { name: meta.data.name, mimeType: outMime, exported, bytes: buf.length };
      if (isTextual(outMime)) {
        const text = buf.toString("utf8");
        return ok({
          summary: `⬇️ Read "${meta.data.name ?? fileId}" (${outMime}, ${buf.length} bytes)`,
          ...base,
          text,
        });
      }
      const limit = maxBytes ?? 750_000;
      if (buf.length > limit) {
        return fail(
          `File is ${buf.length} bytes (binary) — too large to inline. Raise maxBytes (max 8MB) ` +
            `or keep it in Drive / save the attachment to Drive instead.`,
        );
      }
      return ok({
        summary: `⬇️ Downloaded "${meta.data.name ?? fileId}" (${outMime}, ${buf.length} bytes, base64)`,
        ...base,
        base64: buf.toString("base64"),
      });
    }),
  );

  server.registerTool(
    "drive_upload_file",
    {
      title: "Upload / create a new Drive file",
      description:
        "Create a new file in Drive from provided content. " +
        "To overwrite an existing file use drive_overwrite_file instead. " +
        "Pass either `contentText` (UTF-8) or `contentBase64` (binary).",
      inputSchema: {
        account,
        name: z.string().describe("File name, e.g. 'report.pdf'."),
        mimeType: z.string().optional().describe("e.g. 'application/pdf', 'text/plain'. Default octet-stream."),
        parentId: z.string().optional().describe("Destination folder id."),
        _parentFolderName: z.string().optional().describe("Destination folder name (for the approval dialog — fill from context if known)."),
        contentText: z.string().optional(),
        contentBase64: z.string().optional(),
      },
      annotations: { destructiveHint: false },
    },
    guard(async ({ account, name, mimeType, parentId, contentText, contentBase64 }) => {
      if (!contentText && !contentBase64) {
        return fail("Provide either contentText or contentBase64.");
      }
      const g = clients.resolve(account);
      const buffer = contentBase64
        ? Buffer.from(contentBase64, "base64")
        : Buffer.from(contentText ?? "", "utf8");
      const mediaMimeType = mimeType ?? "application/octet-stream";
      const res = await g.drive.files.create({
        requestBody: { name, parents: parentId ? [parentId] : undefined },
        media: { mimeType: mediaMimeType, body: Readable.from(buffer) },
        fields: "id,name,mimeType,size,webViewLink",
      });
      return ok({
        summary: `⬆️ Uploaded "${res.data.name ?? name}" (${res.data.mimeType ?? mediaMimeType}, ${buffer.length} bytes)`,
        id: res.data.id,
        name: res.data.name,
        mimeType: res.data.mimeType,
        size: res.data.size,
        webViewLink: res.data.webViewLink,
      });
    }),
  );

  server.registerTool(
    "drive_overwrite_file",
    {
      title: "Overwrite an existing Drive file",
      description:
        "Replace the content of an existing Drive file by its id. " +
        "This is destructive — the previous content is lost (unless you versioned it first). " +
        "Pass `_fileName` if already known — it appears in the approval dialog. " +
        "Pass either `contentText` (UTF-8) or `contentBase64` (binary).",
      inputSchema: {
        account,
        fileId: z.string().describe("Id of the file to overwrite."),
        _fileName: z.string().optional().describe("File name (for the approval dialog — fill from context if known)."),
        name: z.string().optional().describe("New file name. Omit to keep the existing name."),
        mimeType: z.string().optional().describe("e.g. 'application/pdf', 'text/plain'."),
        contentText: z.string().optional(),
        contentBase64: z.string().optional(),
      },
      annotations: { destructiveHint: true },
    },
    guard(async ({ account, fileId, _fileName, name, mimeType, contentText, contentBase64 }) => {
      if (!contentText && !contentBase64) {
        return fail("Provide either contentText or contentBase64.");
      }
      const g = clients.resolve(account);

      let resolvedName = _fileName ?? name ?? null;
      if (!resolvedName) {
        try {
          const meta = await g.drive.files.get({ fileId, fields: "name" });
          resolvedName = meta.data.name ?? null;
        } catch {}
      }

      const buffer = contentBase64
        ? Buffer.from(contentBase64, "base64")
        : Buffer.from(contentText ?? "", "utf8");
      const mediaMimeType = mimeType ?? "application/octet-stream";
      const res = await g.drive.files.update({
        fileId,
        requestBody: name ? { name } : {},
        media: { mimeType: mediaMimeType, body: Readable.from(buffer) },
        fields: "id,name,mimeType,size,webViewLink",
      });
      return ok({
        summary: `♻️ Overwrote "${res.data.name ?? resolvedName ?? fileId}" (${res.data.mimeType ?? mediaMimeType}, ${buffer.length} bytes)`,
        id: res.data.id,
        name: res.data.name,
        mimeType: res.data.mimeType,
        size: res.data.size,
        webViewLink: res.data.webViewLink,
      });
    }),
  );

  server.registerTool(
    "drive_extract_text",
    {
      title: "Extract text from a PDF/image (OCR)",
      description:
        "Extract text from a Drive file (PDF, scan, or image) using Google Drive's built-in OCR. " +
        "Converts it to a temporary Google Doc, reads the text, and cleans up. Use this for scanned " +
        "invoices/receipts where the body is an image — returns plain text the model can actually read.",
      inputSchema: {
        account,
        fileId: z.string().describe("Drive file id of the PDF/image."),
        ocrLanguage: z
          .string()
          .optional()
          .describe("Optional language hint, e.g. 'en', 'ru'. Improves OCR accuracy."),
      },
      annotations: { destructiveHint: false },
    },
    guard(async ({ account, fileId, ocrLanguage }) => {
      const g = clients.resolve(account);
      const copy = await g.drive.files.copy({
        fileId,
        ocrLanguage,
        requestBody: { name: "gmcp-ocr-tmp", mimeType: GOOGLE_DOC_MIME },
        fields: "id",
      });
      const docId = copy.data.id!;
      try {
        const doc = await g.docs.documents.get({ documentId: docId });
        const text = documentToPlainText(doc.data);
        return ok({
          summary: `📄 Extracted text from file ${fileId} via OCR — ${text.length} char(s)`,
          fileId,
          text,
        });
      } finally {
        await g.drive.files.delete({ fileId: docId }).catch(() => {});
      }
    }),
  );
}
