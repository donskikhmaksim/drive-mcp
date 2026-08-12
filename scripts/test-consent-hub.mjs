#!/usr/bin/env node
/**
 * Часть 2 (`docs/TZ_consent_web_hub.md`): `/pending-consents` и
 * `/pending-consents/decide` — авторизация общим секретом (тестовый план
 * п.7-8) и честная деградация без Postgres (`storeReady()===false` в этом
 * offline-окружении — та же ситуация, что уже покрывает
 * `test-automation-key-catalog.mjs`'s [4]: нет DATABASE_URL здесь, поэтому
 * глубокая семантика confirm/reject/binding_mismatch (тестовый план п.9-11 —
 * требует реального Postgres под `tryAutoExecute`/`consumeManifest`) здесь
 * НЕ покрывается живым HTTP; она проверена по коду (переиспользует
 * `tryAutoExecute`, уже покрытый `scripts/test-consent.mjs`'s [16]) и ручным
 * ревью — см. отчёт по задаче. Что ЭТОТ файл покрывает железно: секрет
 * задан/не задан/неверный → правильные коды, тело запроса валидируется
 * ДО похода в стор, честная деградация (не 500) без Postgres.
 *
 * CONSENT_HUB_SECRET должен быть выставлен ДО импорта dist/server.js —
 * читается один раз при загрузке модуля.
 *
 * Usage: node scripts/test-consent-hub.mjs
 */
process.env.CONSENT_HUB_SECRET = "test-hub-secret-xyz";

const { startHttpServer } = await import("../dist/http.js");

let failures = 0;
const check = (label, cond, extra = "") => {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${label}${cond ? "" : ` — got: ${extra}`}`);
  if (!cond) failures++;
};

const port = 37000 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${port}`;
const config = { transport: "http", port, requireAuth: false, users: [], onboarding: { enabled: false } };
await startHttpServer(config);

console.log("\n[1] Без заголовка / с неверным секретом → 404 на обоих роутах (не 401/403 — не подтверждаем роут)");
{
  const noHeader = await fetch(`${base}/pending-consents`);
  check("GET без заголовка → 404", noHeader.status === 404, String(noHeader.status));

  const wrongHeader = await fetch(`${base}/pending-consents`, { headers: { "x-consent-hub-secret": "wrong" } });
  check("GET с неверным секретом → 404", wrongHeader.status === 404, String(wrongHeader.status));

  const postWrong = await fetch(`${base}/pending-consents/decide`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-consent-hub-secret": "wrong" },
    body: JSON.stringify({ manifestId: "x", decision: "confirm" }),
  });
  check("POST с неверным секретом → 404", postWrong.status === 404, String(postWrong.status));
}

console.log("\n[2] С верным секретом, БЕЗ Postgres (storeReady=false) → честная деградация, не 500");
{
  const getRes = await fetch(`${base}/pending-consents`, { headers: { "x-consent-hub-secret": "test-hub-secret-xyz" } });
  check("GET со верным секретом → 200", getRes.status === 200, String(getRes.status));
  const body = await getRes.json();
  check("service === 'drive'", body.service === "drive", JSON.stringify(body));
  check("items === [] (стор не готов — честно пусто, не падение)", Array.isArray(body.items) && body.items.length === 0, JSON.stringify(body));

  const postRes = await fetch(`${base}/pending-consents/decide`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-consent-hub-secret": "test-hub-secret-xyz" },
    body: JSON.stringify({ manifestId: "does-not-exist", decision: "confirm" }),
  });
  check("POST decide без стора → 404 not_found (не 500)", postRes.status === 404, String(postRes.status));
  const postBody = await postRes.json();
  check("машиночитаемый error='not_found'", postBody.error === "not_found", JSON.stringify(postBody));
}

console.log("\n[3] Тело запроса валидируется ДО похода в стор → 400 bad_request на плохом теле");
{
  const missingManifest = await fetch(`${base}/pending-consents/decide`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-consent-hub-secret": "test-hub-secret-xyz" },
    body: JSON.stringify({ decision: "confirm" }),
  });
  check("без manifestId → 400", missingManifest.status === 400, String(missingManifest.status));

  const badDecision = await fetch(`${base}/pending-consents/decide`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-consent-hub-secret": "test-hub-secret-xyz" },
    body: JSON.stringify({ manifestId: "x", decision: "maybe" }),
  });
  check("decision не в {confirm,reject} → 400", badDecision.status === 400, String(badDecision.status));
  const badBody = await badDecision.json();
  check("машиночитаемый error='bad_request'", badBody.error === "bad_request", JSON.stringify(badBody));
}

console.log(failures === 0 ? "\nAll consent-hub checks passed.\n" : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
