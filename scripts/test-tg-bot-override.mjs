#!/usr/bin/env node
/**
 * TG_BOT_TOKEN_OVERRIDE — единый флаг-переключатель "свой Telegram-бот
 * вместо общего флотского" (`config.ts`'s `loadTgApprovalConfig`/`ownBot`).
 *
 * Контекст: 6 MCP-серверов (ticktick-mcp, gmail-mcp, drive-mcp, docs-mcp,
 * sheets-mcp, calendar-mcp) сейчас делят ОДИН Telegram-бот/токен для запроса
 * подтверждения мутирующих операций (см. `TgApprovalConfig`'s `webhookOwner`
 * doc-comment и `tg_approval.ts`'s file-level comment). Эта задача даёт
 * КАЖДОМУ серверу возможность получить свой отдельный бот/токен через ОДИН
 * env-флаг `TG_BOT_TOKEN_OVERRIDE`, с полной обратной совместимостью: флаг не
 * задан → всё работает побитово как раньше (доказано отдельно в
 * test-tg-approval.mjs секции [11]/[12] и test-tg-webhook-gate.mjs
 * сценариях [a]-[c], которые остаются нетронутыми и зелёными).
 *
 * Этот файл тестирует ИМЕННО резолюцию `config.ts`'s `loadTgApprovalConfig`
 * (приоритет override над TG_BOT_TOKEN, вычисление `ownBot`) — то, что не
 * покрыто ни test-tg-approval.mjs (там `TgApprovalConfig` строится вручную
 * через `tgCfg()`, `loadTgApprovalConfig` не вызывается), ни
 * test-tg-webhook-gate.mjs (тот доказывает эффект флага на HTTP-роуте и
 * registerWebhook через отдельные процессы, но не саму логику резолюции).
 *
 * `loadTgApprovalConfig` — чистая функция от `process.env`, вызываемая
 * заново при каждом вызове (в отличие от `server.ts`'s `tgApprovalConfig`,
 * который кэшируется как module-level singleton при импорте) — поэтому
 * достаточно мутировать `process.env` между вызовами В ОДНОМ процессе, без
 * spawn'а дочерних (в отличие от test-tg-webhook-gate.mjs).
 *
 * Запуск: node scripts/test-tg-bot-override.mjs
 */
import { loadTgApprovalConfig } from "../src/config.ts";

let failures = 0;
const check = (label, cond, extra = "") => {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${label}${cond ? "" : ` — ${extra}`}`);
  if (!cond) failures++;
};

const BASE_ENV = {
  TG_APPROVAL_ENABLED: "true",
  TG_OWNER_CHAT_ID: "555",
  TG_APPROVAL_WEBHOOK_SECRET: "wh-secret-xyz",
  PUBLIC_BASE_URL: "https://example.test",
};

/** Runs loadTgApprovalConfig() under a fully-controlled process.env, restoring afterwards. */
function withEnv(overrides, fn) {
  const keys = new Set([...Object.keys(BASE_ENV), ...Object.keys(overrides)]);
  const saved = {};
  for (const k of keys) saved[k] = process.env[k];
  for (const k of keys) delete process.env[k];
  Object.assign(process.env, BASE_ENV, overrides);
  try {
    return fn();
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

// ═══ [1] Обратная совместимость: TG_BOT_TOKEN_OVERRIDE не задан ═══
console.log("\n[1] TG_BOT_TOKEN_OVERRIDE не задан — botToken из TG_BOT_TOKEN, ownBot=false (побитово как раньше)");
{
  const cfg = withEnv({ TG_BOT_TOKEN: "shared-fleet-token" }, () => loadTgApprovalConfig("drive"));
  check("botToken === TG_BOT_TOKEN", cfg.botToken === "shared-fleet-token", cfg.botToken);
  check("ownBot === false", cfg.ownBot === false, cfg.ownBot);
}

// ═══ [2] TG_BOT_TOKEN_OVERRIDE задан — приоритетнее TG_BOT_TOKEN ═══
console.log("\n[2] TG_BOT_TOKEN_OVERRIDE задан (вместе с TG_BOT_TOKEN) — override побеждает, ownBot=true");
{
  const cfg = withEnv(
    { TG_BOT_TOKEN: "shared-fleet-token", TG_BOT_TOKEN_OVERRIDE: "own-drive-bot-token" },
    () => loadTgApprovalConfig("drive"),
  );
  check("botToken === TG_BOT_TOKEN_OVERRIDE (не TG_BOT_TOKEN)", cfg.botToken === "own-drive-bot-token", cfg.botToken);
  check("ownBot === true", cfg.ownBot === true, cfg.ownBot);
}

// ═══ [3] TG_BOT_TOKEN_OVERRIDE задан, TG_BOT_TOKEN вовсе не задан ═══
console.log("\n[3] TG_BOT_TOKEN_OVERRIDE задан, TG_BOT_TOKEN не задан — override один тоже достаточен");
{
  const cfg = withEnv({ TG_BOT_TOKEN_OVERRIDE: "own-drive-bot-token" }, () => loadTgApprovalConfig("drive"));
  check("botToken === TG_BOT_TOKEN_OVERRIDE", cfg.botToken === "own-drive-bot-token", cfg.botToken);
  check("ownBot === true", cfg.ownBot === true, cfg.ownBot);
  check(
    "startup-проверка не падает (ownBot засчитывается как валидный botToken)",
    typeof cfg.botToken === "string" && cfg.botToken.length > 0,
  );
}

// ═══ [4] Пустая строка TG_BOT_TOKEN_OVERRIDE (whitespace-only) трактуется как "не задан" ═══
console.log("\n[4] TG_BOT_TOKEN_OVERRIDE = пробелы — трактуется как unset, падаем обратно на TG_BOT_TOKEN");
{
  const cfg = withEnv(
    { TG_BOT_TOKEN: "shared-fleet-token", TG_BOT_TOKEN_OVERRIDE: "   " },
    () => loadTgApprovalConfig("drive"),
  );
  check("botToken === TG_BOT_TOKEN (override пуст после trim)", cfg.botToken === "shared-fleet-token", cfg.botToken);
  check("ownBot === false", cfg.ownBot === false, cfg.ownBot);
}

// ═══ [5] Fail-fast startup-проверка: ENABLED=true без ЛЮБОГО источника бот-токена всё ещё падает ═══
console.log("\n[5] TG_APPROVAL_ENABLED=true без TG_BOT_TOKEN и без TG_BOT_TOKEN_OVERRIDE — по-прежнему падает громко (fail-fast не ослаблен)");
{
  let threw = null;
  withEnv({}, () => {
    try {
      loadTgApprovalConfig("drive");
    } catch (err) {
      threw = err;
    }
  });
  check("loadTgApprovalConfig бросил ошибку", threw instanceof Error, threw);
  check(
    "сообщение упоминает оба источника токена (TG_BOT_TOKEN и TG_BOT_TOKEN_OVERRIDE)",
    threw && /TG_BOT_TOKEN/.test(threw.message) && /TG_BOT_TOKEN_OVERRIDE/.test(threw.message),
    threw?.message,
  );
}

// ── итог ─────────────────────────────────────────────────────────────────
console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL CHECKS PASSED");
process.exit(failures ? 1 : 0);
