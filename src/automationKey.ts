/**
 * automationKey.ts — read-only automation_key проверка для drive-mcp.
 *
 * ТЗ: `docs/TZ_automation_key_consent_gate.md`. Этот сервис НИКОГДА не
 * генерирует и не отзывает окна automation_key — это исключительно
 * gmail-mcp (`docs/TZ_automation_key_hub.md`, `src/automation_key.ts` там).
 * Этот модуль только отвечает на вопрос "покрывает ли присланный сырой ключ
 * сервис 'drive' прямо сейчас?", хэшируя его и проверяя общую таблицу
 * `tg_automation_windows` через `store.ts` (тот же Postgres/`pool`, что и
 * `consent_manifests`/`tg_approvals` — см. `store.ts`'s `initStore`).
 *
 * Нет статического канала AUTOMATION_KEY: в отличие от некоторых
 * соседних сервисов, у drive-mcp никогда не было отдельной env-переменной
 * со статическим ключом, поэтому здесь существует только канал "window"
 * (ТЗ, раздел "Что менять — сервер", п.1: "если нет — просто не будет
 * канала static").
 */

import { createHash } from "node:crypto";
import { findActiveAutomationWindow } from "./store.js";

/** Каноническое имя ЭТОГО сервиса в `tg_automation_windows.scope`
 * (`docs/TZ_automation_key_hub.md`: gmail/calendar/drive/sheets/docs/ticktick). */
export const AUTOMATION_SERVICE = "drive";

/**
 * true, если `scope` (csv токенов, или буквально "all") покрывает вызов
 * `tool` внутри `service`. Токены CSV бывают трёх видов:
 *  - `all` — покрывает всё (обрабатывается отдельной веткой ниже);
 *  - `<service>` — весь сервис целиком, ЛЮБОЙ его метод (обратная
 *    совместимость со старыми окнами, выпущенными до этого ТЗ);
 *  - `<service>:<tool>` — ровно один метод.
 * Сравнение токенов — ТОЧНОЕ (`===`), не подстрока/`startsWith`: тот же
 * принцип, что уже защищает от "google-sheets матчит sheets", теперь ещё и
 * от "gmail:gmail_send матчит gmail:gmail_send_extra".
 */
export function scopeCovers(scope: string, service: string, tool: string): boolean {
  if (scope === "all") return true;
  const tokens = scope
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return tokens.some((t) => t === service || t === `${service}:${tool}`);
}

/**
 * DI-форма, которую ожидает `consent.ts`'s `RequireConsentParams.
 * checkAutomationKey`. Любой отказ (пустой вход, ошибка БД, таблица не
 * существует, ключ не найден, scope не покрывает "drive"/этот метод)
 * схлопывается в `{ ok: false }` — `consent.ts` трактует это как тихий
 * fallthrough на обычный человеческий путь, а не как ошибку, показанную
 * модели (gate.md: не подсказывать, что параметр вообще проверялся).
 */
export async function checkAutomationKey(
  rawKey: string,
  tool: string,
): Promise<{ ok: boolean; channel?: string }> {
  const key = rawKey.trim();
  if (!key) return { ok: false };
  try {
    const tokenHash = createHash("sha256").update(key).digest("hex");
    const window = await findActiveAutomationWindow(tokenHash, Date.now());
    if (!window) return { ok: false };
    if (!scopeCovers(window.scope, AUTOMATION_SERVICE, tool)) return { ok: false };
    return { ok: true, channel: `window:${window.windowId}` };
  } catch (err) {
    // Таблица могла ещё не существовать (свежая БД, gmail-mcp ни разу не
    // стартовал) или временная сетевая ошибка — fail-safe: не блокировать,
    // не падать, просто не дать бонуса. Обычный путь остаётся доступен.
    console.error("checkAutomationKey(drive): lookup failed, falling through to human path:", err);
    return { ok: false };
  }
}
