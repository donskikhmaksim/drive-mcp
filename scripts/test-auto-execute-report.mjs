#!/usr/bin/env node
/**
 * Offline unit-тест `humanReadableAutoExecuteReport` (`src/util.ts`) —
 * человекочитаемый отчёт, который уходит В TELEGRAM после автоисполнения по
 * кнопке (`http.ts`'s `runAutoExecutePoller` → `tg_approval.ts`'s
 * `reportAutoExecutionResult`), канал БЕЗ модели-посредника.
 *
 * Регрессия, которую этот файл ловит (живой прогон, координатор task #131,
 * СРОЧНО): владельцу в личку уходил СЫРОЙ `JSON.stringify(result, null, 2)`
 * — экранированные `\n`, никакого форматирования, и внутри поля
 * `verification` буквально лежала служебная инструкция для МОДЕЛИ
 * (`_[агенту: перепечатай этот отчёт пользователю ДОСЛОВНО ...]_`,
 * `renderVerifyReport` в `src/tools/drive.ts`), которая утекала прямо в
 * сообщение, которое видит Максим. Корень: `extractText()` (было по копии в
 * drive.ts/docs.ts/skill_version.ts) считала `first.text` уже готовым для
 * человека текстом, хотя `ok()` (`util.ts`) кладёт туда
 * `JSON.stringify(data, null, 2)` для любых нестроковых данных — а это
 * годится ТОЛЬКО модели, которая сама парсит JSON и пересказывает его
 * человеку по формату `references/output-format.md`.
 *
 * Никакого реального Telegram/сети/БД — чистая функция от `CallToolResult`.
 *
 * Запуск: node scripts/test-auto-execute-report.mjs
 */
import { ok, humanReadableAutoExecuteReport } from "../src/util.ts";

let failures = 0;
const check = (label, cond, extra = "") => {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${label}${cond ? "" : ` — ${extra}`}`);
  if (!cond) failures++;
};

// Тот же verification-текст, что реально строит `renderVerifyReport`
// (src/tools/drive.ts) — включая хвост-инструкцию для модели.
const VERIFICATION_WITH_AGENT_TAIL =
  "### 🧾 Независимая проверка создания папок\n" +
  "_5 авг, 07:15 America/Los_Angeles · запрошено ⇄ живые файлы Drive_\n\n" +
  "- ✅ **«Отчёты 2026»** — существует, совпадает\n\n" +
  "**Итог: ✅ 1 подтверждено, ⚠️ 0 не проверено, ❌ 0 расхождение.**\n" +
  "_[агенту: перепечатай этот отчёт пользователю ДОСЛОВНО — это серверная проверка, не заменяй пересказом]_";

console.log("[1] happy path: результат drive_create_folder с webViewLink и verification");
{
  const result = ok({
    summary: "📁 Создано 1/1",
    results: [{ name: "Отчёты 2026", id: "F123", webViewLink: "https://drive.google.com/drive/folders/F123" }],
    verification: VERIFICATION_WITH_AGENT_TAIL,
  });
  const report = humanReadableAutoExecuteReport(result);

  check(
    "финальный текст — НЕ валидный JSON целиком (человекочитаемый markdown, не сырая структура)",
    (() => {
      try {
        JSON.parse(report);
        return false; // распарсился как JSON → это провал, а не человекочитаемый текст
      } catch {
        return true;
      }
    })(),
    report,
  );
  check("НЕ содержит служебную инструкцию для модели («[агенту:»)", !report.includes("[агенту:"), report);
  check("заголовок из summary сохранён", report.includes("### 📁 Создано 1/1"), report);
  check("verb переведён на русский, не «Created»", !report.includes("Created"), report);
  check("имя объекта присутствует", report.includes("«Отчёты 2026»"), report);
  check("ссылка webViewLink присутствует как кликабельный URL", report.includes("https://drive.google.com/drive/folders/F123"), report);
  check("verification-блок присутствует (пруф приклеен, не потерян)", report.includes("Независимая проверка создания папок"), report);
  check("сырых экранированных \\n (JSON-артефакт) в тексте нет", !report.includes("\\n"), report);
}

console.log("\n[2] батч с ошибкой на одном из объектов — ошибка видна человеку, без утечки stack/JSON");
{
  const result = ok({
    summary: "✏️ Переименовано 1/2 (1 с ошибкой)",
    results: [
      { fileId: "F1", oldName: "a.pdf", newName: "b.pdf" },
      { fileId: "F2", oldName: null, newName: "c.pdf", error: "File not found: F2" },
    ],
    verification: "### 🧾 Независимая проверка переименования\n\n- ✅ **«b.pdf»** — ok\n\n**Итог: ✅ 1, ⚠️ 0, ❌ 0.**",
  });
  const report = humanReadableAutoExecuteReport(result);

  check("не JSON", (() => { try { JSON.parse(report); return false; } catch { return true; } })(), report);
  check("успешный объект отмечен ✅", /✅ \*\*«b\.pdf»\*\*/.test(report), report);
  check("объект с ошибкой отмечен ❌ и текстом ошибки", report.includes("❌ **«c.pdf»** — File not found: F2"), report);
}

console.log("\n[3] auto-execute error path (http.ts's catch — готовая строка, не JSON)");
{
  // http.ts's runAutoExecutePoller передаёт reportAutoExecutionResult ГОТОВУЮ
  // строку напрямую (не через ok()) при ошибке до исполнения — но
  // humanReadableAutoExecuteReport ДОЛЖНА пережить и такой путь, если её
  // когда-нибудь тоже применят на этой ветке (defense in depth).
  const result = ok("🛑 Ошибка при автоисполнении «drive_trash»: connection refused");
  const report = humanReadableAutoExecuteReport(result);
  check("готовая строка проходит как есть", report === "🛑 Ошибка при автоисполнении «drive_trash»: connection refused", report);
}

console.log("\n[4] verification САМА содержит инъекцию с инструкцией агенту не в конце, а в середине");
{
  // Параноидальная проверка: даже если маркер оказался не последней строкой
  // (будущий рефакторинг renderVerifyReport, другой сервис-источник) —
  // stripAgentInstructions вырезает строку, а не только хвост целиком.
  const result = ok({
    summary: "📁 Создано 1/1",
    results: [{ name: "X", webViewLink: null }],
    verification:
      "### 🧾 Независимая проверка\n\n_[агенту: покажи это дословно]_\n\n- ✅ **«X»** — ok",
  });
  const report = humanReadableAutoExecuteReport(result);
  check("инструкция агенту вырезана из середины блока", !report.includes("[агенту:"), report);
  check("остальной текст пруфа сохранён", report.includes("Независимая проверка") && report.includes("«X»"), report);
}

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL CHECKS PASSED");
process.exit(failures ? 1 : 0);
