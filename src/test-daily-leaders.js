// Интеграционный тест для фичи "лидер дня" (баннер для веб-гостей + личное
// сообщение в Telegram). Отдельный скрипт, а не часть game-logic.test.js,
// потому что тут нужен реально поднятый Express-сервер (для /api/auth) и
// require() server.js + db.js В ОДНОМ процессе, чтобы они делили одно и то
// же in-memory состояние (как и test для /matchday в прошлый раз).
//
// Запуск: node src/test-daily-leaders.js

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "goalgame-test-"));
process.env.DATA_DIR = DATA_DIR;
process.env.BOT_TOKEN = "123456:test_fake_token_for_local_only";
process.env.PUBLIC_URL = "https://example.invalid"; // webhook-ветка — без long polling к фейковому токену
process.env.PORT = "0"; // 0 = ОС сама выберет свободный порт
process.env.ADMIN_TELEGRAM_ID = "";

const app = require("./server"); // main() внутри уже запускает app.listen(...)
const db = require("./db");
const logic = require("./game-logic");

let passed = 0;
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log(`  ok - ${name}`);
    })
    .catch((err) => {
      realConsoleError(`  FAIL - ${name}`);
      realConsoleError(err);
      process.exitCode = 1;
    });
}

// Перехватываем console.error, чтобы проверить, реально ли пытались слать
// сообщение в Telegram (и когда — нет).
const errorLog = [];
const realConsoleError = console.error;
console.error = (...args) => {
  errorLog.push(args.map(String).join(" "));
};

// check() свою ошибку логирует через realConsoleError напрямую (а не через
// console.error), чтобы её было видно в терминале, даже пока console.error
// перехвачен для проверки логики рассылки.

function clubHourTimestamp(baseNow, hour) {
  const offsetMs = logic.CLUB_UTC_OFFSET_HOURS * 60 * 60 * 1000;
  const shifted = new Date(baseNow + offsetMs);
  const dayUtcMs = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate(), hour, 0, 0);
  return dayUtcMs - offsetMs;
}

async function main() {
  // Ждём, пока express реально начнёт слушать порт (app.listen внутри main()
  // сервера асинхронный, но по факту синхронно навешивает слушатель почти
  // сразу — небольшая пауза для надёжности).
  await new Promise((r) => setTimeout(r, 300));
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  const now = Date.now();
  const yKey = logic.yesterdayKey(now);
  const notifyNow = clubHourTimestamp(now, 10); // 10:00 по времени клуба — уже можно слать

  await check("веб-гость — лидер дня видит баннер в /api/auth один раз", async () => {
    const webUser = db.getOrCreateUser("web_leader123", { firstName: "ВебЛидер" });
    // Имитируем реальный сценарий: вчера (dayKey=yKey) забил 9 голов и больше
    // не заходил. Первый же вызов /api/auth сегодня сам "заморозит" это в
    // prevDayKey/prevDayGoals через ensureCurrentDay() — так же, как у
    // настоящего игрока, а не напрямую руками (иначе тест не отражал бы
    // реальный путь данных).
    webUser.dayKey = yKey;
    webUser.dayGoals = 9;
    webUser.leaderBannerShownForDay = null;
    db.saveUser(webUser);

    const res1 = await fetch(`${base}/api/auth`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ webId: "web_leader123", webName: "ВебЛидер" }),
    }).then((r) => r.json());
    assert.deepStrictEqual(res1.leaderBanner, { goals: 9 });

    const res2 = await fetch(`${base}/api/auth`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ webId: "web_leader123", webName: "ВебЛидер" }),
    }).then((r) => r.json());
    assert.strictEqual(res2.leaderBanner, null); // второй раз баннер уже не показываем
  });

  await check("до наступления утреннего часа рассылка не запускается", async () => {
    errorLog.length = 0;
    db.setLastLeaderNotifyDayKey(null);
    const earlyNow = clubHourTimestamp(now, 5); // 5 утра по клубу — рано
    await app.notifyDailyLeadersIfDue(earlyNow);
    assert.strictEqual(db.getSettings().lastLeaderNotifyDayKey, null);
    assert.strictEqual(errorLog.length, 0);
  });

  await check("веб-гостю (лидеру) НЕ шлём личное сообщение — он не в Telegram", async () => {
    errorLog.length = 0;
    db.setLastLeaderNotifyDayKey(null);
    // На этот момент единственный вчерашний лидер — веб-гость (см. первый тест).
    await app.notifyDailyLeadersIfDue(notifyNow);
    assert.strictEqual(errorLog.length, 0); // никаких попыток sendMessage для web_*
    assert.strictEqual(db.getSettings().lastLeaderNotifyDayKey, logic.dateKey(notifyNow)); // но день всё равно отмечен обработанным
  });

  await check("Telegram-лидеру дня пытаемся отправить личное сообщение от бота", async () => {
    db.setLastLeaderNotifyDayKey(null);
    // Добавляем telegram-игрока с результатом выше, чем у веб-гостя — теперь
    // при topN=1 лидер дня — именно он.
    const tgUser = db.getOrCreateUser("555555555", { firstName: "ТГ-Чемпион" });
    tgUser.prevDayKey = yKey;
    tgUser.prevDayGoals = 15;
    db.saveUser(tgUser);

    errorLog.length = 0;
    await app.notifyDailyLeadersIfDue(notifyNow);
    // Токен фейковый — реальная отправка не удастся, но сама попытка должна
    // состояться именно для этого пользователя (и залогироваться как ошибка).
    const attempted = errorLog.some((line) => line.includes("555555555"));
    assert.ok(attempted, `ожидали попытку отправки для 555555555, лог: ${JSON.stringify(errorLog)}`);
    assert.strictEqual(db.getSettings().lastLeaderNotifyDayKey, logic.dateKey(notifyNow));
  });

  await check("повторный вызов в тот же день не дублирует рассылку", async () => {
    const before = errorLog.length;
    await app.notifyDailyLeadersIfDue(notifyNow);
    assert.strictEqual(errorLog.length, before); // ничего нового не залогировано — сработал дедуп
  });

  console.error = realConsoleError;
  server.close();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  console.log(`\n${passed} тест(ов) пройдено успешно.`);
  process.exit(process.exitCode || 0);
}

main().catch((err) => {
  console.error = realConsoleError;
  console.error("Ошибка теста:", err);
  process.exit(1);
});
