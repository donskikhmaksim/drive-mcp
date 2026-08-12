/**
 * gated_tools_catalog.ts — автоматический справочник гейтированных методов.
 *
 * ТЗ: `docs/TZ_automation_key_method_catalog.md`, раздел "Что делать в КАЖДОМ
 * из пяти сервисов", п.1. Цель: список методов, которые можно указать в
 * `scope` окна `automation_key` как `<service>:<tool>`, НИГДЕ не хранится
 * руками — при добавлении нового гейтированного тула (новый
 * `server.registerTool(...)`, чья Zod-схема несёт `automation_key`) он
 * появляется в этом списке сам.
 *
 * Механизм — официальный, протокольный: поднимаем связанную пару
 * транспортов `InMemoryTransport.createLinkedPair()` (штатная утилита
 * самого SDK, используется в его собственных тестах и уже в этом репо —
 * см. `scripts/test-drive-gate.mjs`), подключаем лёгкий `Client` к уже
 * собранному `McpServer` и зовём `client.listTools()` — тот же
 * `tools/list`, что видит любой реальный MCP-клиент. Это даёт список тулов
 * ВМЕСТЕ с их JSON-схемой параметров без чтения приватного поля
 * `_registeredTools` (оно физически доступно на объекте `McpServer`, но не
 * публичный контракт SDK и ломкое на апдейтах — намеренно не используется).
 *
 * "Гейтирован" ⟺ "`inputSchema.properties.automation_key` присутствует в
 * JSON-схеме, отданной `tools/list`" — по `TZ_automation_key_consent_gate.md`
 * КАЖДЫЙ гейтированный тул обязан нести Zod-параметр `automation_key`, так
 * что это точный и полный критерий, без ручного списка где бы то ни было.
 *
 * Ограничение (честно, а не молча): набор тулов в этом сервере НЕ зависит
 * от конкретного пользователя (`User`) — `buildMcpServer(user)` регистрирует
 * один и тот же набор `drive_*`/`docs_*`/`skill_version_update` независимо
 * от того, сколько у пользователя Google-аккаунтов (`clients.multi` меняет
 * только текст описания сервера, не набор тулов). Поэтому синтетический
 * `User` ниже — не "типовой пользователь" в смысле приближения, а РОВНО тот
 * же набор тулов, что видит любой реальный пользователь этого сервера.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

export interface GatedToolSummary {
  name: string;
  description: string;
}

/** Обрезка описания для UI — справочник отдаёт короткую подсказку, не
 * полный докстринг тула (тот бывает многоабзацным, с ТЗ-ссылками). */
const MAX_DESCRIPTION_LENGTH = 160;

function truncateDescription(raw: string | undefined): string {
  const text = (raw ?? "").trim();
  if (text.length <= MAX_DESCRIPTION_LENGTH) return text;
  return text.slice(0, MAX_DESCRIPTION_LENGTH - 1).trimEnd() + "…";
}

/**
 * Возвращает список гейтированных тулов уже собранного `McpServer` —
 * `{name, description}[]`, отсортированный по имени для стабильного вывода.
 * Поднимает и закрывает временную in-memory транспортную пару, ничего не
 * оставляет висеть после возврата.
 */
export async function listGatedTools(server: McpServer): Promise<GatedToolSummary[]> {
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "gated-tools-catalog", version: "1.0.0" });
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const { tools } = await client.listTools();
    return tools
      .filter((tool) => {
        const props = (tool.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
        return props !== undefined && Object.prototype.hasOwnProperty.call(props, "automation_key");
      })
      .map((tool) => ({ name: tool.name, description: truncateDescription(tool.description) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
}
