/**
 * autoExecute.ts — реестр «ядер исполнения» гейтованных тулов, вызываемых
 * фоновым поллером НАПРЯМУЮ (в обход MCP-транспорта и модели вообще) — см.
 * consent.ts's `tryAutoExecute` doc-comment (Максим, 2026-08-05: «нажал
 * кнопку — сразу исполнилось на бэке»).
 *
 * КРИТИЧНО ПРО БЕЗОПАСНОСТЬ: этот реестр НИКОГДА не выставляется как
 * MCP-параметр инструмента (никакого `auto_confirmed: true` в схеме) — модель
 * не может вызвать `execute` отсюда никаким аргументом. Единственный
 * вызывающий — поллер сервера (`http.ts`'s `runAutoExecutePoller`), который
 * САМ находит кандидатов через `store.listApprovedUnexecuted()` (Postgres,
 * не аргумент вызова) и вызывает `tryAutoExecute()` (не пропускает binding/
 * one-shot, только классификацию текстовой реплики — TG-кнопка уже была
 * единственным доказанным согласием для этого тула).
 *
 * Регистрация — на уровне МОДУЛЯ (при импорте), не внутри `registerXTools()`
 * (та функция вызывается ПОВТОРНО на каждый MCP-запрос — реестр не должен
 * зависеть от того, приходил ли уже хоть один запрос).
 */

import type { UserClients } from "./accounts.js";
import type { ConsentStore, ConsentAddressing } from "./consent.js";

export interface AutoExecutorCtx {
  clients: UserClients;
  consentStore: ConsentStore;
}

/**
 * Ctx-параметр добавлен (Максим, drive.ts перевод 2026-08-05) поверх
 * исходного gmail_send-only контракта: `gmail_send`'s rehash — вырожденный
 * случай (`sha256(payload)`, без похода в живой мир), так что он не нуждался
 * в `ctx`. Большинство drive_*-тулов используют РЕАЛЬНЫЙ rehash (перечитывают
 * живой Drive через `GoogleClients`, который нужно резолвить per-account —
 * см. `../tools/drive.ts`'s `Rehash`-хелперы), поэтому здесь и нужен `ctx` —
 * без него drive-тулы физически не могли бы сходить в живой мир из
 * авто-пути. `http.ts`'s `runAutoExecutePoller` передаёт его при вызове.
 */
export type RehashFn = (addressing: ConsentAddressing, ctx: AutoExecutorCtx) => string | Promise<string>;
/** Возвращает ГОТОВЫЙ человекочитаемый текст отчёта — то же самое, что тул
 * вернул бы модели в чат при обычном (не-авто) исполнении, включая ссылку/
 * артефакт, если тул её производит (см. `_extractText` в http.ts). */
export type ExecuteFn = (payload: unknown, auditId: string, ctx: AutoExecutorCtx) => Promise<string>;

export interface AutoExecutorEntry {
  rehash: RehashFn;
  execute: ExecuteFn;
}

const registry = new Map<string, AutoExecutorEntry>();

export function registerAutoExecutor(tool: string, entry: AutoExecutorEntry): void {
  if (registry.has(tool)) {
    // Может случиться при hot-reload в dev — в проде импорт модуля происходит
    // ровно один раз, так что молчаливая перезапись здесь безобиднее, чем
    // падение, но лог всё равно печатаем, чтобы не потерять сигнал о баге.
    console.error(`autoExecute: tool "${tool}" уже зарегистрирован — перезаписываю`);
  }
  registry.set(tool, entry);
}

export function getAutoExecutor(tool: string): AutoExecutorEntry | undefined {
  return registry.get(tool);
}

export function registeredAutoExecuteTools(): string[] {
  return [...registry.keys()];
}
