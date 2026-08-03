// Интеграционные тесты для трёх фич: реферальная механика, зал славы,
// конкурс дня. Тот же приём, что и в test-daily-leaders.js — require()
// server.js и db.js в одном процессе, поднимаем реальный Express-сервер,
// дёргаем HTTP-запросами и напрямую проверяем состояние через db.
//
// Запуск: node src/test-referral-hof-contest.js

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "goalgame-test-"));
process.env.DATA_DIR = DATA_DIR;
process.env.BOT_TOKEN = "123456:test_fake_token_for_local_only";
process.env.PUBLIC_URL = "https://example.invalid";
process.env.PORT = "0";
process.env.ADMIN_TELEGRAM_ID = "700000";
process.env.DEV_ALLOW_FAKE_AUTH = "1"; // разрешает initData вида "dev:<id>" — см. telegram-auth.js

const app = require("./server");
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

const errorLog = [];
const realConsoleError = console.error;
console.error = (...args) => {
  errorLog.push(args.map(String).join(" "));
};

function clubDateTimestamp(baseNow, weekday, hour) {
  const offsetMs = logic.CLUB_UTC_OFFSET_HOURS * 3600000;
  const shifted = new Date(baseNow + offsetMs);
  const diffDays = weekday - shifted.getUTCDay();
  const dayUtcMs = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate() + diffDays, hour, 0, 0);
  return dayUtcMs - offsetMs;
}

async function auth(base, body) {
  return fetch(`${base}/api/auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => r.json());
}

async function main() {
  await new Promise((r) => setTimeout(r, 300));
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  // ------------------------- Реферальная механика -------------------------

  await check("новый веб-гость по реферальной ссылке получает бонус, инвайтер — тоже", async () => {
    const inviterRes = await auth(base, { initData: "dev:600001" });
    assert.strictEqual(inviterRes.maxEnergy, 8);
    assert.strictEqual(inviterRes.referralCount, 0);

    const inviteeRes = await auth(base, { webId: "web_invitee01", webName: "Друг", ref: "600001" });
    assert.strictEqual(inviteeRes.referralApplied, true);
    assert.strictEqual(inviteeRes.maxEnergy, 9); // 8 (дефолт нового игрока) + 1

    const inviterAgain = await auth(base, { initData: "dev:600001" });
    assert.strictEqual(inviterAgain.maxEnergy, 9); // 8 + 1 постоянно
    assert.strictEqual(inviterAgain.referralCount, 1);
    assert.ok(inviterAgain.achievements.includes("referral_1"), "ожидали значок «Заводила» у инвайтера");
  });

  await check("повторный вход того же приглашённого не начисляет бонус повторно", async () => {
    const again = await auth(base, { webId: "web_invitee01", webName: "Друг", ref: "600001" });
    assert.strictEqual(again.referralApplied, false);
    assert.strictEqual(again.maxEnergy, 9); // не выросло повторно

    const inviterAfter = await auth(base, { initData: "dev:600001" });
    assert.strictEqual(inviterAfter.referralCount, 1); // тоже не выросло
  });

  await check("реферал самому себе не засчитывается", async () => {
    const res = await auth(base, { initData: "dev:600002", ref: "600002" });
    assert.strictEqual(res.referralApplied, false);
    assert.strictEqual(res.maxEnergy, 8);
  });

  await check("реферал на несуществующего инвайтера тихо игнорируется", async () => {
    const res = await auth(base, { initData: "dev:600003", ref: "000000" });
    assert.strictEqual(res.referralApplied, false);
    assert.strictEqual(res.maxEnergy, 8);
  });

  // ------------------------- Зал славы -------------------------

  await check("/api/hall-of-fame отдаёт три категории", async () => {
    const u = db.getUser("600001");
    u.bestScore = 5;
    u.bestStreak = 7;
    u.totalGoals = 42;
    db.saveUser(u);

    const hof = await fetch(`${base}/api/hall-of-fame`).then((r) => r.json());
    assert.ok(Array.isArray(hof.bestMatch));
    assert.ok(Array.isArray(hof.longestStreak));
    assert.ok(Array.isArray(hof.totalGoals));
    assert.ok(hof.totalGoals.some((r) => r.id === "600001" && r.value === 42));
  });

  await check("веб-гость видит баннер зала славы раз в неделю, не чаще", async () => {
    const first = await auth(base, { webId: "web_hofuser01", webName: "Гость" });
    assert.ok(first.hallOfFameBanner, "ожидали баннер зала славы при первом заходе на этой неделе");
    assert.ok(Array.isArray(first.hallOfFameBanner.totalGoals));

    const second = await auth(base, { webId: "web_hofuser01", webName: "Гость" });
    assert.strictEqual(second.hallOfFameBanner, null);
  });

  await check("еженедельная рассылка зала славы уходит только по понедельникам после назначенного часа", async () => {
    db.setLastHallOfFameNotifyWeekKey(null);
    const now = Date.now();
    const wednesday10 = clubDateTimestamp(now, 3, 10);
    const monday5 = clubDateTimestamp(now, 1, 5);
    const monday10 = clubDateTimestamp(now, 1, 10);

    errorLog.length = 0;
    await app.notifyHallOfFameIfDue(wednesday10);
    assert.strictEqual(db.getSettings().lastHallOfFameNotifyWeekKey, null);

    await app.notifyHallOfFameIfDue(monday5);
    assert.strictEqual(db.getSettings().lastHallOfFameNotifyWeekKey, null);

    await app.notifyHallOfFameIfDue(monday10);
    assert.strictEqual(db.getSettings().lastHallOfFameNotifyWeekKey, logic.weekKey(monday10));
    const attempted = errorLog.some((l) => l.includes("зал славы"));
    assert.ok(attempted, `ожидали попытку рассылки, лог: ${JSON.stringify(errorLog)}`);

    const before = errorLog.length;
    await app.notifyHallOfFameIfDue(monday10);
    assert.strictEqual(errorLog.length, before); // повторно в ту же неделю не шлём
  });

  // ------------------------- Конкурс дня -------------------------

  await check("во время конкурса энергия безлимитная даже при нуле, голы копятся в contestGoals", async () => {
    // Выжигаем всю энергию обычным способом (без конкурса).
    const drainId = "600020";
    await auth(base, { initData: `dev:${drainId}` });
    for (let i = 0; i < 8; i++) {
      const start = await fetch(`${base}/api/match/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ initData: `dev:${drainId}` }),
      }).then((r) => r.json());
      await fetch(`${base}/api/match/result`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ initData: `dev:${drainId}`, token: start.token, goals: 1 }),
      }).then((r) => r.json());
    }
    const drained = await auth(base, { initData: `dev:${drainId}` });
    assert.strictEqual(drained.energy, 0);

    const startFail = await fetch(`${base}/api/match/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ initData: `dev:${drainId}` }),
    });
    assert.strictEqual(startFail.status, 409); // без конкурса — энергии действительно нет

    const contestStartTs = Date.now();
    db.setContestStart(contestStartTs);

    const startOk = await fetch(`${base}/api/match/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ initData: `dev:${drainId}` }),
    }).then((r) => r.json());
    assert.strictEqual(startOk.unlimited, true);

    await fetch(`${base}/api/match/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ initData: `dev:${drainId}`, token: startOk.token, goals: 4 }),
    }).then((r) => r.json());

    const afterUser = db.getUser(drainId);
    assert.strictEqual(afterUser.contestGoals, 4);
    assert.strictEqual(afterUser.contestGoalsForStartTs, contestStartTs);
  });

  await check("итоги конкурса включают всех участников (в т.ч. веб-гостя) и админу уходит попытка отправки", async () => {
    const contestStartTs = db.getSettings().contestStartTs;
    assert.ok(contestStartTs, "ожидали, что конкурс из предыдущего теста ещё активен");

    // Второй участник — веб-гость, забивает больше голов, должен стать победителем.
    await auth(base, { webId: "web_contestant01", webName: "Соперник" });
    const start2 = await fetch(`${base}/api/match/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ webId: "web_contestant01" }),
    }).then((r) => r.json());
    await fetch(`${base}/api/match/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ webId: "web_contestant01", token: start2.token, goals: 5 }),
    }).then((r) => r.json());

    const resultsBefore = logic.buildContestResults(db.getAllUsers(), contestStartTs);
    assert.strictEqual(resultsBefore[0].id, "web_contestant01"); // 5 > 4 — веб-гость первый
    assert.strictEqual(resultsBefore[0].isTelegram, false);
    assert.strictEqual(resultsBefore[1].isTelegram, true);

    errorLog.length = 0;
    await app.finalizeContestNow(contestStartTs, "тестовое завершение");
    assert.strictEqual(db.getSettings().contestStartTs, null); // деактивирован
    const attemptedAdmin = errorLog.some((l) => l.includes("700000"));
    assert.ok(attemptedAdmin, `ожидали попытку отправки итогов админу 700000, лог: ${JSON.stringify(errorLog)}`);
  });

  await check("finalizeContestNow шлёт личные итоги участникам из Telegram (не только админу)", async () => {
    const contestStartTs = Date.now();
    db.setContestStart(contestStartTs);

    // Ещё один telegram-участник (не админ), забивает голы в счёт конкурса.
    const participantId = "600030";
    await auth(base, { initData: `dev:${participantId}` });
    const start3 = await fetch(`${base}/api/match/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ initData: `dev:${participantId}` }),
    }).then((r) => r.json());
    await fetch(`${base}/api/match/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ initData: `dev:${participantId}`, token: start3.token, goals: 2 }),
    }).then((r) => r.json());

    errorLog.length = 0;
    await app.finalizeContestNow(contestStartTs, "тестовое завершение с участником");
    const attemptedParticipant = errorLog.some((l) => l.includes(participantId));
    assert.ok(attemptedParticipant, `ожидали попытку личной отправки итогов участнику ${participantId}, лог: ${JSON.stringify(errorLog)}`);
  });

  await check("startContestNow запускает конкурс и рассылает анонс всем Telegram-игрокам (веб-гостям — нет)", async () => {
    db.setContestStart(null); // на всякий случай, чтобы предыдущий тест не мешал
    errorLog.length = 0;
    const now = Date.now();
    await app.startContestNow(now, "Три браслета с символикой клуба");
    assert.strictEqual(db.getSettings().contestStartTs, now);
    assert.strictEqual(db.getSettings().contestScheduledStart, null);

    // 600001 — telegram-игрок из более раннего теста, ему должна прийти попытка рассылки.
    const attemptedTelegram = errorLog.some((l) => l.includes("600001"));
    assert.ok(attemptedTelegram, `ожидали попытку анонса telegram-игроку 600001, лог: ${JSON.stringify(errorLog)}`);
    // веб-гостю (web_invitee01) рассылка не должна даже пытаться уйти — у него нет chat-id.
    const attemptedWebGuest = errorLog.some((l) => l.includes("web_invitee01"));
    assert.strictEqual(attemptedWebGuest, false, "веб-гостю анонс не должен отправляться");

    await app.finalizeContestNow(now, "тестовое завершение анонса");
  });

  await check("/contest_at планирует автостарт, startScheduledContestIfDue стартует не раньше срока", async () => {
    db.setContestSchedule(null, null);
    const now = Date.now();
    const future = now + 3600000; // через час
    db.setContestSchedule(future, "Тестовый приз");

    errorLog.length = 0;
    await app.startScheduledContestIfDue(now); // ещё рано
    assert.strictEqual(db.getSettings().contestStartTs, null);
    assert.strictEqual(db.getSettings().contestScheduledStart, future);

    await app.startScheduledContestIfDue(future + 1000); // время настало
    assert.strictEqual(db.getSettings().contestStartTs, future + 1000);
    assert.strictEqual(db.getSettings().contestScheduledStart, null); // план очищен после старта

    await app.finalizeContestNow(future + 1000, "тестовое завершение по расписанию");
  });

  await check("finalizeContestIfDue не завершает конкурс раньше 24 часов, но завершает после", async () => {
    const startTs = Date.now();
    db.setContestStart(startTs);

    errorLog.length = 0;
    await app.finalizeContestIfDue(startTs + 1000); // прошла всего секунда
    assert.strictEqual(db.getSettings().contestStartTs, startTs); // всё ещё активен

    await app.finalizeContestIfDue(startTs + logic.CONTEST_DURATION_MS + 1000); // прошли сутки
    assert.strictEqual(db.getSettings().contestStartTs, null); // автозавершился
    const attempted = errorLog.some((l) => l.includes("700000"));
    assert.ok(attempted, "ожидали автоматическую отправку итогов админу по истечении 24 часов");
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
