import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { buildUserClients } from "./accounts.js";
import { registerDriveTools } from "./tools/drive.js";
export function buildMcpServer(user) {
    const clients = buildUserClients(user);
    const accountsHint = clients.multi
        ? `Multiple Google accounts available: ${clients.names.join(", ")} (default: ${clients.defaultName}). Pass \`account\` to select.`
        : `One Google account ("${clients.defaultName}") is configured.`;
    const server = new McpServer({ name: "drive-mcp", version: "1.0.0" }, { instructions: "Tools to organise Google Drive: search, upload, download, move, rename, trash files and folders. " + accountsHint });
    registerDriveTools(server, clients);
    return server;
}
