#!/usr/bin/env node
/**
 * Часть 2 (`docs/TZ_consent_web_hub.md`): `CONSENT_HUB_SECRET` НЕ задан ⇒
 * оба новых роута (`GET /pending-consents`, `POST /pending-consents/decide`)
 * обязаны отвечать 404 — fail-closed, не открытый доступ (ТЗ, тестовый план
 * п.8). Отдельный файл/процесс от test-consent-hub.mjs, так как
 * `CONSENT_HUB_SECRET` читается ОДИН РАЗ при импорте `server.js` (модульная
 * константа `consentHubSecret`) — переключить его в рамках одного процесса
 * невозможно, нужен отдельный запуск node без переменной окружения.
 *
 * Usage: node scripts/test-consent-hub-disabled.mjs (без CONSENT_HUB_SECRET в env)
 */
delete process.env.CONSENT_HUB_SECRET;

const { startHttpServer } = await import("../dist/http.js");

let failures = 0;
const check = (label, cond, extra = "") => {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${label}${cond ? "" : ` — got: ${extra}`}`);
  if (!cond) failures++;
};

console.log("\n[1] CONSENT_HUB_SECRET не задан → оба роута 404, остальной сервис работает");
{
  const port = 36000 + Math.floor(Math.random() * 1000);
  const config = { transport: "http", port, requireAuth: false, users: [], onboarding: { enabled: false } };
  await startHttpServer(config);

  const getRes = await fetch(`http://127.0.0.1:${port}/pending-consents`, {
    headers: { "x-consent-hub-secret": "anything" },
  });
  check("GET /pending-consents → 404 (секрет не задан)", getRes.status === 404, String(getRes.status));

  const postRes = await fetch(`http://127.0.0.1:${port}/pending-consents/decide`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-consent-hub-secret": "anything" },
    body: JSON.stringify({ manifestId: "x", decision: "confirm" }),
  });
  check("POST /pending-consents/decide → 404 (секрет не задан)", postRes.status === 404, String(postRes.status));

  const healthRes = await fetch(`http://127.0.0.1:${port}/health`);
  check("остальной сервис (/health) работает как обычно", healthRes.status === 200, String(healthRes.status));
}

console.log(failures === 0 ? "\nAll consent-hub-disabled checks passed.\n" : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
