/**
 * skill_version_update — auto-versioning for Claude skills stored on Google Drive.
 *
 * Layout on Drive:
 *   Skills/
 *     [skill_name]/
 *       [skill_name]_vX.X_YYYY-MM-DD.md   ← current (top-level)
 *       versions/
 *         [skill_name]_vX.Y_YYYY-MM-DD.md ← archived
 *
 * SKILLS_ROOT_FOLDER_ID is hardcoded — this tool cannot touch anything outside
 * that folder, making it safe for always_allow.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ok, fail, guard } from "../util.js";
import type { UserClients } from "../accounts.js";

const SKILLS_ROOT_FOLDER_ID = "1kjYll-ULT_Z1CFG80HcwgJR6AaS6CVg9";
const VERSIONS_FOLDER_NAME = "versions";
const ACCOUNT = "personal";

/** Compare semver-ish strings like "3.2" < "3.3" < "10.0". */
function versionGt(a: string, b: string): boolean {
  const parts = (v: string) => v.split(".").map((x) => parseInt(x, 10) || 0);
  const [aMaj, aMin = 0] = parts(a);
  const [bMaj, bMin = 0] = parts(b);
  return aMaj !== bMaj ? aMaj > bMaj : aMin > bMin;
}

/** Extract version string from filename like `email_management_v3.2_2026-06-30.md` → "3.2" */
function extractVersion(filename: string): string | null {
  const m = /_v(\d+\.\d+)_/.exec(filename);
  return m ? m[1] : null;
}

export function registerSkillVersionTools(server: McpServer, userClients: UserClients) {
  server.registerTool(
    "skill_version_update",
    {
      title: "Update skill version on Drive",
      description:
        "Archive the current skill file to versions/ and create a new version. " +
        "Operates only inside Skills/ folder — safe for always_allow. " +
        "Guards against downgrade and name collisions.",
      inputSchema: {
        skill_name: z.string().describe("Skill folder name, e.g. 'email_management'."),
        new_version: z.string().describe("New version string, e.g. '3.3'."),
        new_content: z.string().describe("Full markdown content of the new skill file."),
        date: z.string().optional().describe("Date override YYYY-MM-DD (default: today)."),
      },
      annotations: { destructiveHint: false },
    },
    guard(async ({ skill_name, new_version, new_content, date }) => {
      const g = userClients.resolve(ACCOUNT);
      const today = date ?? new Date().toISOString().slice(0, 10);
      const newFileName = `${skill_name}_v${new_version}_${today}.md`;

      // ── 1. Find skill folder inside Skills/ ──────────────────────────────
      const skillFolderRes = await g.drive.files.list({
        q: `name='${skill_name}' and '${SKILLS_ROOT_FOLDER_ID}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
        fields: "files(id,name)",
        pageSize: 5,
      });
      const skillFolder = skillFolderRes.data.files?.[0];
      if (!skillFolder?.id) {
        return fail(`Skill folder "${skill_name}" not found inside Skills/. Create it first.`);
      }
      const skillFolderId = skillFolder.id;

      // ── 2. Find current top-level .md files in skill folder ──────────────
      const topFilesRes = await g.drive.files.list({
        q: `'${skillFolderId}' in parents and name contains '.md' and mimeType='text/plain' and trashed=false`,
        fields: "files(id,name)",
        pageSize: 20,
      });
      const topFiles = topFilesRes.data.files ?? [];

      // Pick the one with the highest version number
      let currentFile: { id: string; name: string; version: string } | null = null;
      for (const f of topFiles) {
        if (!f.id || !f.name) continue;
        const v = extractVersion(f.name);
        if (!v) continue;
        if (!currentFile || versionGt(v, currentFile.version)) {
          currentFile = { id: f.id, name: f.name, version: v };
        }
      }

      // ── 3. Downgrade protection ──────────────────────────────────────────
      if (currentFile && !versionGt(new_version, currentFile.version)) {
        return fail(
          `Downgrade blocked: current version is ${currentFile.version}, ` +
          `requested new_version ${new_version} is not greater.`,
        );
      }

      // ── 4. Collision check ───────────────────────────────────────────────
      const collision = topFiles.find((f) => f.name === newFileName);
      if (collision) {
        return fail(`File "${newFileName}" already exists in the skill folder. Bump version or delete it first.`);
      }

      // ── 5. Find or create versions/ subfolder ────────────────────────────
      let versionsFolderId: string;
      const vfRes = await g.drive.files.list({
        q: `name='${VERSIONS_FOLDER_NAME}' and '${skillFolderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
        fields: "files(id)",
        pageSize: 2,
      });
      if (vfRes.data.files?.[0]?.id) {
        versionsFolderId = vfRes.data.files[0].id;
      } else {
        const created = await g.drive.files.create({
          requestBody: {
            name: VERSIONS_FOLDER_NAME,
            mimeType: "application/vnd.google-apps.folder",
            parents: [skillFolderId],
          },
          fields: "id",
        });
        if (!created.data.id) return fail("Failed to create versions/ folder.");
        versionsFolderId = created.data.id;
      }

      // ── 6. Archive current file → versions/ ─────────────────────────────
      let archivedFile: { id: string; name: string } | null = null;
      if (currentFile) {
        await g.drive.files.update({
          fileId: currentFile.id,
          addParents: versionsFolderId,
          removeParents: skillFolderId,
          fields: "id,parents",
        });
        archivedFile = { id: currentFile.id, name: currentFile.name };
      }

      // ── 7. Create new file at top level ─────────────────────────────────
      let newFileId: string;
      try {
        const { Readable } = await import("node:stream");
        const created = await g.drive.files.create({
          requestBody: {
            name: newFileName,
            mimeType: "text/plain",
            parents: [skillFolderId],
          },
          media: {
            mimeType: "text/plain",
            body: Readable.from([new_content]),
          },
          fields: "id",
        });
        if (!created.data.id) throw new Error("Drive did not return file id.");
        newFileId = created.data.id;
      } catch (err) {
        const hint = archivedFile
          ? ` Archived file is at versions/${archivedFile.name} (id: ${archivedFile.id}) — move it back manually if needed.`
          : "";
        return fail(`Failed to create new file: ${(err as Error).message}.${hint}`);
      }

      return ok({
        summary: `✅ Skill "${skill_name}" updated to v${new_version}`,
        newFile: { id: newFileId, name: newFileName },
        archivedFile,
        skillFolder: { id: skillFolderId, name: skill_name },
      });
    }),
  );
}
