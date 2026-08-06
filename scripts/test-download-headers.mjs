#!/usr/bin/env node
/**
 * Заголовки безопасности на маршруте отдачи файла по ссылке
 * (`GET /dl/<token>`, src/http.ts's `createDownloadHandler`) — регресс-защита,
 * а не «дыра первого порядка».
 *
 * Что проверяется и почему:
 *  - `X-Content-Type-Options: nosniff`. `Content-Disposition: attachment` уже
 *    не даёт браузеру отрендерить ответ как страницу при переходе по ссылке,
 *    но НЕ мешает загрузить тот же URL подресурсом чужой страницы
 *    (`<script src=…>`, `<object>`, `<embed>`) — там без nosniff браузер
 *    вправе определить тип по содержимому и исполнить загруженный HTML/JS
 *    (security-checklist.md §10, «файлы и загрузки»).
 *  - `Content-Disposition: attachment…` — чтобы принудительное скачивание
 *    никто не снял позже: тогда HTML начал бы рендериться прямо на домене
 *    сервера, где живут dashboard и OAuth-маршруты.
 * Оба проверяются И для 200, И для 206 (запрос с `Range`): заголовки ставятся
 * до начала пайпа, и частичный ответ не должен их терять.
 *
 * Сеть НЕ трогается вообще: тестируется ровно та функция-обработчик, которую
 * монтирует `startHttpServer`, но с ПОДСТАВНЫМ Google-клиентом (реальный
 * googleapis офлайн не перехватить — google-auth-library ходит мимо undici
 * MockAgent). Хранилище ссылок — то же самое (in-memory `downloads.js`).
 *
 * Usage: node scripts/test-download-headers.mjs   (после `npm run build`)
 */
import express from "express";
import { Readable } from "node:stream";
import { createDownloadHandler } from "../dist/http.js";
import { initDownloads, issueDownloadLink } from "../dist/downloads.js";

const PORT = 35070;
const FILE_ID = "FILEID1";
// Специально «опасное» содержимое и имя: именно такой файл и исполнился бы
// подресурсом чужой страницы, если nosniff когда-нибудь снимут.
const BODY = "<html><script>alert(1)</script></html>";

let failures = 0;
const check = (label, cond, extra = "") => {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${label}${cond ? "" : ` — got: ${extra}`}`);
  if (!cond) failures++;
};

// ── подставной Drive: отдаёт весь файл (200) или кусок (206 + Content-Range) ─
const fakeClients = {
  drive: {
    files: {
      get: async (_params, options) => {
        const range = options?.headers?.Range;
        if (range) {
          const part = BODY.slice(0, 4);
          return {
            status: 206,
            headers: { "content-length": String(part.length), "content-range": `bytes 0-3/${BODY.length}` },
            data: Readable.from([part]),
          };
        }
        return {
          status: 200,
          headers: { "content-length": String(BODY.length) },
          data: Readable.from([BODY]),
        };
      },
      export: async () => {
        throw new Error("export not used in this test");
      },
    },
  },
};

const app = express();
app.get("/dl/:token", createDownloadHandler(async () => fakeClients));
const server = await new Promise((resolve) => {
  const s = app.listen(PORT, "127.0.0.1", () => resolve(s));
});

initDownloads(`http://127.0.0.1:${PORT}`);
const { url } = await issueDownloadLink(
  { account: "default", fileId: FILE_ID, name: "payload.html", mimeType: "text/html" },
  10,
);

// ── [1] обычное скачивание (200) ───────────────────────────────────────────
console.log("\n[1] GET /dl/<token> → 200");
{
  const res = await fetch(url);
  check("статус 200", res.status === 200, String(res.status));
  check(
    "X-Content-Type-Options: nosniff",
    res.headers.get("x-content-type-options") === "nosniff",
    String(res.headers.get("x-content-type-options")),
  );
  check(
    "Content-Disposition начинается с attachment",
    (res.headers.get("content-disposition") ?? "").startsWith("attachment"),
    String(res.headers.get("content-disposition")),
  );
  check("Content-Type — из записи ссылки", (res.headers.get("content-type") ?? "").startsWith("text/html"), String(res.headers.get("content-type")));
  check("Cache-Control: private, no-store", /no-store/.test(res.headers.get("cache-control") ?? ""), String(res.headers.get("cache-control")));
  check("тело дошло целиком", (await res.text()) === BODY);
}

// ── [2] докачка (206) — те же заголовки не теряются ────────────────────────
console.log("\n[2] GET /dl/<token> с Range → 206, те же заголовки");
{
  const res = await fetch(url, { headers: { Range: "bytes=0-3" } });
  check("статус 206", res.status === 206, String(res.status));
  check("Content-Range проброшен", (res.headers.get("content-range") ?? "").startsWith("bytes 0-3/"), String(res.headers.get("content-range")));
  check(
    "X-Content-Type-Options: nosniff и на частичном ответе",
    res.headers.get("x-content-type-options") === "nosniff",
    String(res.headers.get("x-content-type-options")),
  );
  check(
    "Content-Disposition: attachment и на частичном ответе",
    (res.headers.get("content-disposition") ?? "").startsWith("attachment"),
    String(res.headers.get("content-disposition")),
  );
}

// ── [3] неизвестный токен ничего не раскрывает ─────────────────────────────
console.log("\n[3] неизвестный токен → 404 без подробностей");
{
  const res = await fetch(`http://127.0.0.1:${PORT}/dl/nope-nope-nope`);
  check("статус 404", res.status === 404, String(res.status));
  const body = await res.text();
  check("в теле нет id файла", !body.includes(FILE_ID), body.slice(0, 120));
}

server.close();
console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
