import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { User } from "./config.js";
import { buildUserClients } from "./accounts.js";
import { registerDriveTools } from "./tools/drive.js";
import { registerSkillVersionTools } from "./tools/skill_version.js";

export function buildMcpServer(user: User): McpServer {
  const clients = buildUserClients(user);
  const accountsHint = clients.multi
    ? `Multiple Google accounts available: ${clients.names.join(", ")} (default: ${clients.defaultName}). Pass \`account\` to select.`
    : `One Google account ("${clients.defaultName}") is configured.`;

  const server = new McpServer(
    { name: "drive-mcp", version: "1.0.0" },
    { instructions: "Tools to organise Google Drive: search, upload, download, move, rename, trash files and folders. " + accountsHint },
  );
  registerDriveTools(server, clients);
  registerSkillVersionTools(server, clients);
  return server;
}
