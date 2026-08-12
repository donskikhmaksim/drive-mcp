import express, { type Request, type Response } from "express";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import type { Account, Config, User } from "./config.js";
import { buildMcpServer, buildCatalogServer, tgApprovalConfig, tgApprovalStoreAdapter, consentStoreAdapter, consentServerConfig, consentHubSecret } from "./server.js";
import { listGatedTools } from "./gated_tools_catalog.js";
import { AUTOMATION_SERVICE } from "./automationKey.js";
import { handleWebhook, registerWebhook, secretTokenMatches, reportAutoExecutionResult } from "./tg_approval.js";
import { tryAutoExecute, type ConsentManifestRow } from "./consent.js";
import { getAutoExecutor } from "./autoExecute.js";
import { GoogleFederatedProvider } from "./oauthProvider.js";
import {
  getGoogleAccounts,
  listGoogleAccounts,
  removeGoogleAccount,
  setDefaultAccount,
  renameAccount,
  listApprovedUnexecuted,
  listAwaitingConsentManifests,
  getManifest,
  invalidateManifest,
  appendConsentAudit,
  storeReady,
} from "./store.js";
import { renderDashboard } from "./dashboard.js";
import { logDashboardLocation } from "./logRedaction.js";
import { initDownloads, resolveDownloadLink } from "./downloads.js";
import { buildUserClients } from "./accounts.js";
import { selectAccountsForLegacyToken } from "./credentialSource.js";

const JSONRPC_UNAUTHORIZED = {
  jsonrpc: "2.0" as const,
  error: { code: -32001, message: "Unauthorized" },
  id: null,
};

function tokensEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function extractLegacyToken(req: Request): string {
  const header = req.header("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (match?.[1]) return match[1];
  const apiKey = req.header("x-api-key");
  if (apiKey) return apiKey;
  const q = req.query?.key ?? req.query?.token;
  if (typeof q === "string") return q;
  return "";
}

function resolveLegacyUser(req: Request, config: Config): User | null {
  const provided = extractLegacyToken(req);
  if (!provided) return null;
  for (const user of config.users) {
    if (user.token && tokensEqual(provided, user.token)) return user;
  }
  return null;
}

/** Builds the User from ALL Google accounts linked to this instance via onboarding. */
async function userFromGoogleAccounts(config: Config): Promise<User | null> {
  const accounts = await getGoogleAccounts();
  if (!accounts.length) return null;
  const clientId = config.onboarding.googleClientId!;
  const clientSecret = config.onboarding.googleClientSecret!;
  const mapped: Account[] = accounts.map((a) => ({
    name: a.label,
    auth: { mode: "oauth", clientId, clientSecret, refreshToken: a.refreshToken },
  }));
  const def = accounts.find((a) => a.isDefault) ?? accounts[0];
  return {
    name: def.email,
    accounts: mapped,
    defaultAccount: def.label,
  };
}

/**
 * Content-Disposition that survives non-ASCII names: a sanitised fallback for
 * old clients plus the RFC 5987 UTF-8 form modern ones prefer.
 */
function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** Constant-time compare for the dashboard path secret. */
function secretMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Авто-исполнение по кнопке в Telegram (Максим, 2026-08-05: «нажал кнопку —
 * должно сразу исполниться на бэке, не ждать повторного вызова моделью»).
 * В ОТЛИЧИЕ от `runApprovalSweep` (тот работает ТОЛЬКО на владельце
 * вебхука) — этот поллер работает НА КАЖДОМ сервере, включая этот, без
 * гейта по `webhookOwner`: исполнение полностью децентрализовано, сервер
 * следит только за СВОИМИ манифестами (`consent_manifests.server` = свой
 * server) — никакой межпроцессной связи с другими серверами не нужно,
 * кнопка уже централизованно решается общим вебхуком (см. `handleWebhook`),
 * а этот поллер просто видит результат в общем Postgres.
 *
 * Два независимых режима гейта (Максим подтвердил явно) остаются нетронуты:
 * если `TG_APPROVAL_ENABLED=false` (или тул не в allowlist) — сюда манифест
 * вообще не попадёт (нет строки в tg_approvals), обычный чат-«да»-путь через
 * `requireConsent()` работает побайтово как раньше.
 */
async function runAutoExecutePoller(config: Config): Promise<void> {
  const candidates = await listApprovedUnexecuted(consentServerConfig.server, Date.now());
  if (!candidates.length) return;

  const user = (await userFromGoogleAccounts(config)) ?? config.users[0] ?? null;
  if (!user) {
    console.error("TG auto-execute: нет доступного пользователя — пропускаю тик поллера");
    return;
  }
  const clients = buildUserClients(user);

  for (const c of candidates) {
    const executor = getAutoExecutor(c.tool);
    if (!executor) {
      // Инструмент ещё не переведён на новый паттерн (см. autoExecute.ts) —
      // манифест останется PENDING/APPROVED и будет исполнен, как только
      // модель сама позовёт execute (старый путь), либо когда этот тул
      // получит свой executor. НЕ ошибка, просто ещё не покрыто.
      continue;
    }
    try {
      const result = await tryAutoExecute(
        { manifestId: c.manifestId, tool: c.tool, accountLabel: c.accountLabel },
        // executor.rehash теперь принимает ctx (см. autoExecute.ts's RehashFn
        // doc-comment) — tryAutoExecute сам знает только про (addressing) =>
        // ..., так что оборачиваем здесь, где `clients` для этого тика уже
        // построен.
        (addressing) => executor.rehash(addressing, { clients, consentStore: consentStoreAdapter }),
        consentStoreAdapter,
        consentServerConfig,
      );
      if (!result) continue; // гонка/дрейф/истёк — тихо пропускаем, это не ошибка
      const reportText = await executor.execute(result.payload, result.auditId, { clients, consentStore: consentStoreAdapter });
      await reportAutoExecutionResult(tgApprovalConfig, c.chatId, c.messageId, reportText);
    } catch (err) {
      console.error(`TG auto-execute: ошибка при исполнении ${c.tool}/${c.manifestId}:`, err);
      // НЕ помечаем как исполненное при ошибке ДО tryAutoExecute — если он
      // успел вызвать consumeManifest (манифест одноразовый), повторной
      // попытки уже не будет; отчёт об ошибке всё равно стоит попытаться
      // отправить, чтобы Максим не остался с зависшими кнопками в боте.
      await reportAutoExecutionResult(
        tgApprovalConfig, c.chatId, c.messageId,
        `🛑 Ошибка при автоисполнении «${c.tool}»: ${err instanceof Error ? err.message : String(err)}`,
      ).catch(() => {});
    }
  }
}

export async function startHttpServer(config: Config): Promise<void> {
  const app = express();
  // Railway (and most PaaS) terminate TLS behind a reverse proxy; trust its
  // X-Forwarded-For so express-rate-limit (used by the SDK's auth handlers)
  // keys correctly per real client IP instead of the proxy's.
  app.set("trust proxy", 1);
  app.use(express.json({ limit: "10mb" }));
  // Dashboard forms POST application/x-www-form-urlencoded.
  app.use(express.urlencoded({ extended: false }));

  app.get("/", (_req, res) => {
    res.json({ status: "ok", endpoint: "/mcp" });
  });
  app.get("/health", (_req, res) => res.json({ status: "ok" }));

  // ---- automation_key method catalog (TZ_automation_key_method_catalog.md) ----
  // Список ИМЁН гейтированных методов этого сервиса (drive_*/docs_*/
  // skill_version_update — все живут в одном процессе под каноническим
  // AUTOMATION_SERVICE="drive") для выбора scope "<service>:<tool>" в
  // окне automation_key. Без авторизации намеренно: список имён методов не
  // чувствительные данные (тот же принцип, что и tools/list по факту
  // доступен любому, кто прошёл MCP-авторизацию — здесь даже без неё).
  app.get("/automation-key-catalog", async (_req: Request, res: Response) => {
    try {
      const server = buildCatalogServer();
      const tools = await listGatedTools(server);
      res.json({ service: AUTOMATION_SERVICE, tools });
    } catch (err) {
      console.error("GET /automation-key-catalog failed:", err);
      res.status(500).json({ error: "catalog_unavailable" });
    }
  });

  // ---- Часть 2 (TZ_consent_web_hub.md): backend-роуты веб-хаба подтверждений ----
  // Общий секрет CONSENT_HUB_SECRET (X-Consent-Hub-Secret, константное
  // сравнение — тот же приём, что и у /dashboard/:secret выше). Секрет не
  // задан ⇒ ОБА роута отвечают 404 (fail-closed: не 401/403, чтобы не
  // подтверждать существование роута кому-то без секрета вообще).
  const hubAuthorized = (req: Request): boolean => {
    if (!consentHubSecret) return false;
    const provided = req.header("x-consent-hub-secret") ?? "";
    return !!provided && secretMatches(provided, consentHubSecret);
  };

  /** Пункт списка `/pending-consents` (ТЗ Часть 2, п.1). В `consent_manifests`
   * НЕТ отдельных колонок title/summary/preview (только `payload`/JSON) —
   * миграцию таблицы ТЗ явно просит не делать без нужды, так что здесь ЧЕСТНО
   * выводим короткие поля из уже существующего `payload`, а не из полного
   * markdown-превью модели (оно нигде не сохраняется, строится заново на
   * каждый `plan()` и уходит либо в ответ модели, либо в Telegram — see
   * `consent.ts`'s `requireConsent`). Ограничение отмечено в отчёте по задаче.
   */
  const toPendingItem = (row: ConsentManifestRow) => {
    let compact: string;
    try {
      compact = JSON.stringify(row.payload);
    } catch {
      compact = String(row.payload);
    }
    const summary = compact.length > 160 ? `${compact.slice(0, 159)}…` : compact;
    return {
      manifestId: row.id,
      tool: row.tool,
      title: row.tool,
      summary,
      preview: compact,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      accountLabel: row.accountLabel,
    };
  };

  app.get("/pending-consents", async (req: Request, res: Response) => {
    if (!hubAuthorized(req)) {
      res.status(404).end();
      return;
    }
    if (!storeReady()) {
      res.json({ service: consentServerConfig.server, items: [] });
      return;
    }
    try {
      const rows = await listAwaitingConsentManifests(consentServerConfig.server, Date.now());
      res.json({ service: consentServerConfig.server, items: rows.map(toPendingItem) });
    } catch (err) {
      console.error("GET /pending-consents failed:", err);
      res.status(500).json({ error: "unavailable" });
    }
  });

  app.post("/pending-consents/decide", async (req: Request, res: Response) => {
    if (!hubAuthorized(req)) {
      res.status(404).end();
      return;
    }
    const manifestId = typeof req.body?.manifestId === "string" ? req.body.manifestId : "";
    const decision = req.body?.decision;
    const comment = typeof req.body?.comment === "string" ? req.body.comment : "";
    if (!manifestId || (decision !== "confirm" && decision !== "reject")) {
      res.status(400).json({ ok: false, error: "bad_request" });
      return;
    }
    if (!storeReady()) {
      res.status(404).json({ ok: false, error: "not_found" });
      return;
    }
    try {
      const row = await getManifest(manifestId, consentServerConfig.server);
      if (!row) {
        res.status(404).json({ ok: false, error: "not_found" });
        return;
      }
      if (row.status !== "AWAITING_CONSENT") {
        res.status(409).json({ ok: false, error: "already_decided" });
        return;
      }
      if (row.expiresAt <= Date.now()) {
        res.status(410).json({ ok: false, error: "expired" });
        return;
      }

      if (decision === "reject") {
        // Тот же путь отказа, что и обычная негация в requireConsent
        // (consent.ts, ветка "negation") — invalidate + audit-запись,
        // `comment` (если есть) идёт как `userReply` (та же роль, что и
        // человеческая реплика из Telegram/чата — ТЗ Часть 2, п.2).
        const userReply = comment || "[веб-хаб: отклонено без комментария]";
        await invalidateManifest(manifestId, consentServerConfig.server, userReply);
        await appendConsentAudit({
          id: randomUUID(),
          ts: Date.now(),
          server: consentServerConfig.server,
          tool: row.tool,
          accountLabel: row.accountLabel,
          manifestId,
          objectHash: row.objectHash,
          userReply,
          checks: { source: "consent_hub" },
          outcome: "invalidated",
          refusalReason: "web_hub_reject",
          actor: "human",
        });
        res.json({ ok: true, outcome: "refused" });
        return;
      }

      // decision === "confirm" — РОВНО тот же путь, что нажатие кнопки в
      // Telegram (см. `runAutoExecutePoller` выше): переиспользуем
      // `tryAutoExecute` (rehash-биндинг + атомарный consumeManifest + аудит)
      // и зарегистрированный `AutoExecutorEntry.execute` (`autoExecute.ts`) —
      // НЕ дублируем логику исполнения тула здесь.
      const executor = getAutoExecutor(row.tool);
      if (!executor) {
        // Тул ещё не переведён на паттерн autoExecute.ts — гейт всё ещё
        // рабочий (обычный чат-путь), но веб-хаб для НЕГО пока не может
        // исполнить решение синхронно. Честно, не 500.
        res.status(409).json({ ok: false, error: "no_executor" });
        return;
      }
      const user = (await userFromGoogleAccounts(config)) ?? config.users[0] ?? null;
      if (!user) {
        res.status(503).json({ ok: false, error: "no_account" });
        return;
      }
      const clients = buildUserClients(user);
      const execCtx = { clients, consentStore: consentStoreAdapter };

      // Ранний binding-чек (read-only, идемпотентный) — только чтобы отдать
      // машиночитаемый `binding_mismatch` вместо общего `already_decided`,
      // когда причина именно в рассинхроне состояния (ТЗ Часть 2, п.2).
      const currentHash = await executor.rehash(row.payload, execCtx);
      if (currentHash !== row.objectHash) {
        res.status(409).json({ ok: false, error: "binding_mismatch" });
        return;
      }

      const result = await tryAutoExecute(
        { manifestId, tool: row.tool, accountLabel: row.accountLabel },
        (addressing) => executor.rehash(addressing, execCtx),
        consentStoreAdapter,
        consentServerConfig,
      );
      if (!result) {
        // Гонка — кто-то другой (обычный чат-путь / TG-кнопка) уже забрал
        // этот манифест между чтением выше и этой атомарной попыткой.
        res.status(409).json({ ok: false, error: "already_decided" });
        return;
      }
      const reportText = await executor.execute(result.payload, result.auditId, execCtx);
      res.json({ ok: true, outcome: "confirmed", result: reportText });
    } catch (err) {
      console.error(`POST /pending-consents/decide failed for manifest ${manifestId}:`, err);
      res.status(500).json({ ok: false, error: "internal_error" });
    }
  });

  // ---- Optional Telegram-approval webhook (plan-tg-approval.md) ----
  // Deliberately OUTSIDE the normal /mcp auth -- Telegram itself calls this,
  // not an MCP client. Protected by the secret_token Telegram echoes back on
  // every request (set via registerWebhook's setWebhook call below), checked
  // constant-time. Mounted unconditionally (cheap route, no-op body) so
  // toggling TG_APPROVAL_ENABLED never needs a redeploy of routing -- when
  // disabled, tgApprovalConfig.webhookSecret is "" and secretTokenMatches
  // rejects every request (empty expected secret never matches).
  app.post("/tg/webhook", async (req: Request, res: Response) => {
    // Route-level gate on TG_WEBHOOK_OWNER -- checked FIRST, before reading
    // the secret header or the body. Defense-in-depth alongside
    // registerWebhook's own self-guard (tg_approval.ts): since
    // consumeTgDecisionAnyServer made webhook consume server-agnostic across
    // all 6 MCP servers that will eventually share one Telegram bot token
    // (gmail/sheets/calendar/docs/drive-mcp + ticktick-mcp), a
    // TG_APPROVAL_WEBHOOK_SECRET leak on ANY single one of them would
    // otherwise let an attacker decide approvals for every other server too
    // -- including gmail_send, the most dangerous one. A server that isn't
    // the designated owner must never process this route at all, even with a
    // technically-correct secret, and must never depend on whoever ports this
    // file to the other 5 repos remembering to not mount the route --
    // 404 (not 401) so a non-owner server doesn't even reveal the route exists.
    //
    // drive-mcp NEVER owns the SHARED webhook (see server.ts's `tgApprovalGate`
    // honest note) -- gmail-mcp is the designated owner of that path.
    // TG_WEBHOOK_OWNER must never be set to "true" on this server.
    //
    // TG_BOT_TOKEN_OVERRIDE (config.ts's `ownBot`) is the ONE feature-flag
    // exception, added on top without touching the guard above: when this
    // server has been given its own Telegram bot token, its `/tg/webhook`
    // stops being a shared route at all -- it's this server's own bot's
    // updates, and no other server can register against the same URL/token,
    // so the fleet-wide collision `webhookOwner` guards against does not
    // apply. Backward compatible by construction: `ownBot` is false unless
    // TG_BOT_TOKEN_OVERRIDE is explicitly set, so an unset flag reproduces
    // the exact bitwise-identical gate this route had before this flag
    // existed.
    if (!tgApprovalConfig.webhookOwner && !tgApprovalConfig.ownBot) {
      res.status(404).end();
      return;
    }
    const provided = req.header("x-telegram-bot-api-secret-token") ?? "";
    if (!secretTokenMatches(provided, tgApprovalConfig.webhookSecret)) {
      res.status(401).end();
      return;
    }
    try {
      await handleWebhook(tgApprovalConfig, tgApprovalStoreAdapter, req.body);
    } catch (err) {
      console.error("TG approval webhook error:", err);
    }
    // Always 200 -- Telegram retries on non-2xx, and every failure mode here
    // (wrong from.id, replay, unknown callback_data) is intentionally a no-op,
    // not an error Telegram should retry.
    res.status(200).end();
  });

  initDownloads(config.onboarding.publicBaseUrl);

  // ---- Temporary download links minted by drive_get_download_url ----
  // Deliberately unauthenticated: the unguessable, expiring token in the path
  // IS the credential, and it authorises exactly one file. See downloads.ts.
  app.get("/dl/:token", async (req: Request, res: Response) => {
    const target = await resolveDownloadLink(String(req.params.token));
    if (!target) {
      res.status(404).type("text/plain").send("This download link is invalid or has expired.");
      return;
    }
    const user = (await userFromGoogleAccounts(config)) ?? config.users[0] ?? null;
    if (!user) {
      res.status(503).type("text/plain").send("No Google account is linked to this server any more.");
      return;
    }
    try {
      const g = buildUserClients(user).resolve(target.account);
      // Pass the client's Range through so big downloads can resume.
      const range = req.header("range");
      const options = {
        responseType: "stream" as const,
        headers: range ? { Range: range } : undefined,
      };
      const gres = target.exportMime
        ? await g.drive.files.export({ fileId: target.fileId, mimeType: target.exportMime }, options)
        : await g.drive.files.get(
            { fileId: target.fileId, alt: "media", supportsAllDrives: true },
            options,
          );

      res.status(gres.status === 206 ? 206 : 200);
      res.setHeader("Content-Type", target.mimeType);
      res.setHeader("Content-Disposition", contentDisposition(target.name));
      // `Content-Disposition: attachment` (above) already stops the browser
      // from rendering this response as a page on direct navigation. It does
      // NOT stop the same URL from being loaded as a SUBRESOURCE of someone
      // else's page (<script src=…>, <object>, <embed>) — there, without
      // nosniff, the browser is free to sniff the content and execute it as
      // HTML/JS. `nosniff` closes that: the type is taken from Content-Type
      // only. Second line of defence: exploitation still requires knowing
      // the secret link.
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Accept-Ranges", "bytes");
      // The link is a secret; keep proxies and shared caches out of it.
      res.setHeader("Cache-Control", "private, no-store");
      const length = gres.headers["content-length"];
      if (length) res.setHeader("Content-Length", length);
      const contentRange = gres.headers["content-range"];
      if (contentRange) res.setHeader("Content-Range", contentRange);

      const stream = gres.data as unknown as NodeJS.ReadableStream;
      stream.on("error", (err: Error) => {
        console.error("Download stream error:", err.message);
        res.destroy(err);
      });
      stream.pipe(res);
    } catch (err) {
      console.error("Download error:", err);
      if (!res.headersSent) {
        res.status(502).type("text/plain").send("Could not fetch this file from Google.");
      } else {
        res.destroy();
      }
    }
  });

  let provider: GoogleFederatedProvider | null = null;

  if (config.onboarding.enabled) {
    const baseUrl = config.onboarding.publicBaseUrl!;
    provider = new GoogleFederatedProvider({
      googleClientId: config.onboarding.googleClientId!,
      googleClientSecret: config.onboarding.googleClientSecret!,
      baseUrl,
      relayUrl: config.onboarding.relayUrl,
      relaySecret: config.onboarding.relaySecret,
      ownerEmails: config.onboarding.ownerEmails,
    });

    const issuerUrl = new URL(baseUrl);
    const resourceServerUrl = new URL(`${baseUrl}/mcp`);

    app.use(mcpAuthRouter({
      provider,
      issuerUrl,
      resourceServerUrl,
      scopesSupported: ["sheets", "drive", "docs", "gmail", "calendar"],
    }));

    // Google (via the relay) redirects here after the user grants consent.
    app.get("/oauth/google/callback", async (req: Request, res: Response) => {
      const { code, state, error } = req.query as Record<string, string>;
      if (error) {
        res.status(400).send(`Google returned an error: ${error}. <a href="javascript:history.back()">Go back</a>`);
        return;
      }
      if (!code || !state) {
        res.status(400).send("Missing code or state.");
        return;
      }
      try {
        const result = await provider!.handleGoogleCallback(code, state);
        res.redirect(result.redirectUrl);
      } catch (err) {
        console.error("Google callback error:", err);
        res.status(400).send((err as Error).message);
      }
    });

    // ---- Account-management dashboard (guarded by an unguessable path secret) ----
    const dashSecret = config.onboarding.dashboardSecret;
    if (dashSecret) {
      const base = `/dashboard/${dashSecret}`;
      const guard = (req: Request, res: Response): boolean => {
        if (secretMatches(String(req.params.secret ?? ""), dashSecret)) return true;
        res.status(403).send("Forbidden");
        return false;
      };

      app.get("/dashboard/:secret", async (req: Request, res: Response) => {
        if (!guard(req, res)) return;
        const accounts = await listGoogleAccounts();
        const msg = typeof req.query.msg === "string" ? req.query.msg : undefined;
        res.type("html").send(renderDashboard(base, accounts, msg));
      });

      // Start "add another account" — bounce to Google via the relay.
      app.get("/dashboard/:secret/add", async (req: Request, res: Response) => {
        if (!guard(req, res)) return;
        try {
          const url = await provider!.startAddAccount(baseUrl);
          res.redirect(url);
        } catch (err) {
          console.error("add-account error:", err);
          res.status(400).send((err as Error).message);
        }
      });

      app.post("/dashboard/:secret/remove", async (req: Request, res: Response) => {
        if (!guard(req, res)) return;
        await removeGoogleAccount(String(req.body?.email ?? ""));
        res.redirect(`${base}?msg=removed`);
      });

      app.post("/dashboard/:secret/default", async (req: Request, res: Response) => {
        if (!guard(req, res)) return;
        await setDefaultAccount(String(req.body?.email ?? ""));
        res.redirect(`${base}?msg=default`);
      });

      app.post("/dashboard/:secret/rename", async (req: Request, res: Response) => {
        if (!guard(req, res)) return;
        const ok = await renameAccount(String(req.body?.email ?? ""), String(req.body?.label ?? ""));
        res.redirect(`${base}?msg=${ok ? "renamed" : "rename_failed"}`);
      });

      // #119: НЕ печатать сам секрет — он же пароль от дашборда, а логи
      // Railway видит каждый, у кого есть доступ к проекту.
      logDashboardLocation(baseUrl, base, dashSecret);
    }

    console.error(`Native MCP OAuth enabled — clients connect and authorize directly at ${baseUrl}/mcp`);
  }

  const bearerMiddleware = provider
    ? requireBearerAuth({
        verifier: provider,
        resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(new URL(`${config.onboarding.publicBaseUrl}/mcp`)),
      })
    : null;

  const handleMcp = async (req: Request, res: Response) => {
    let user: User | null = null;

    if (req.auth) {
      // Bearer token validated by requireBearerAuth; resolve the linked Google accounts.
      user = await userFromGoogleAccounts(config);
    } else if (!config.requireAuth) {
      user = config.users[0] ?? null;
    } else {
      // Static MCP_AUTH_TOKEN identifies WHO is calling, but not which Google
      // accounts they get: prefer the live onboarding database when it has
      // accounts linked, falling back to the (possibly empty/stale) env
      // credentials only when the database is empty. See credentialSource.ts.
      const legacyUser = resolveLegacyUser(req, config);
      const onboarded =
        legacyUser && config.onboarding.enabled ? await userFromGoogleAccounts(config) : null;
      user = selectAccountsForLegacyToken(legacyUser, onboarded);
    }

    if (!user) {
      res.status(401).json(JSONRPC_UNAUTHORIZED);
      return;
    }
    const server = buildMcpServer(user);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => { transport.close(); server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("MCP error:", err);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
      }
    }
  };

  if (bearerMiddleware) {
    // Legacy ?key=/x-api-key links (from before native OAuth) keep working by
    // resolving directly against the static env-configured users. Everything
    // else — including requests with NO Authorization header at all — goes
    // through requireBearerAuth, so first-contact discovery requests get a
    // proper 401 + WWW-Authenticate pointing at the protected-resource metadata.
    app.post("/mcp", (req, res, next) => {
      if (resolveLegacyUser(req, config)) return next();
      return bearerMiddleware(req, res, next);
    }, handleMcp);
  } else {
    app.post("/mcp", handleMcp);
  }

  const methodNotAllowed = (_req: Request, res: Response) => {
    res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
  };
  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);

  if (tgApprovalConfig.enabled) {
    await registerWebhook(tgApprovalConfig);

    // Авто-исполнение — отдельный, более частый цикл (отзывчивость важнее
    // для UX: нажал кнопку, ждёшь секунды, а не минуты). Работает на КАЖДОМ
    // сервере без гейта webhookOwner — см. runAutoExecutePoller's doc-comment.
    const AUTO_EXECUTE_INTERVAL_MS = 10 * 1000;
    setInterval(() => {
      runAutoExecutePoller(config).catch((err) =>
        console.error("TG auto-execute poller: unhandled error", err),
      );
    }, AUTO_EXECUTE_INTERVAL_MS).unref();
  }

  await new Promise<void>((resolve) => {
    app.listen(config.port, () => {
      console.error(`MCP listening on :${config.port}  auth=${config.requireAuth ? "on" : "OFF"}  instance=${randomUUID().slice(0, 8)}`);
      if (!config.requireAuth && !config.onboarding.enabled) console.error("WARNING: no MCP_AUTH_TOKEN — endpoint is PUBLIC");
      resolve();
    });
  });
}
