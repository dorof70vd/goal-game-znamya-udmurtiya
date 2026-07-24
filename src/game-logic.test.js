// Простые проверки ключевой логики без внешних тестовых фреймворков —
// достаточно node src/game-logic.test.js (или npm test).

const assert = require("assert");
const logic = require("./game-logic");

function freshUser(overrides = {}) {
  return {
    id: "1",
    username: "tester",
    firstName: "Тест",
    energy: 5,
    maxEnergy: 5,
    lastEnergyTs: Date.now(),
    streak: 0,
    lastPlayedDate: null,
    lastNewsBonusDate: null,
    level: 1,
    bestScore: 0,
    totalGoals: 0,
    weekGoals: 0,
    weekKey: null,
    activeMatch: null,
    ...overrides,
  };
}

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (err) {
    console.error(`  FAIL - ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

console.log("game-logic tests:");

check("энергия не восстанавливается сверх максимума", () => {
  const u = freshUser({ energy: 5, lastEnergyTs: Date.now() - 10 * logic.ENERGY_REGEN_MS });
  logic.applyEnergyRegen(u);
  assert.strictEqual(u.energy, 5);
});

check("энергия восстанавливается по 1 за цикл регенерации", () => {
  const now = Date.now();
  const u = freshUser({ energy: 2, maxEnergy: 5, lastEnergyTs: now - 3 * logic.ENERGY_REGEN_MS });
  logic.applyEnergyRegen(u, now);
  assert.strictEqual(u.energy, 5); // 2 + 3, capped at 5
});

check("energy регенерация не превышает максимум и не теряет остаток времени", () => {
  const now = Date.now();
  const u = freshUser({ energy: 3, maxEnergy: 5, lastEnergyTs: now - 1.5 * logic.ENERGY_REGEN_MS });
  logic.applyEnergyRegen(u, now);
  assert.strictEqual(u.energy, 4); // только 1 полный цикл засчитан
  const msLeft = logic.msUntilNextEnergy(u, now);
  assert.ok(msLeft > 0 && msLeft <= 0.5 * logic.ENERGY_REGEN_MS + 1000);
});

check("первый вход даёт стрик = 1 и бонус энергии", () => {
  const now = Date.now();
  const u = freshUser({ energy: 0, lastPlayedDate: null });
  const res = logic.registerDailyLogin(u, now);
  assert.strictEqual(res.streak, 1);
  assert.strictEqual(res.bonusEnergy, 1);
  assert.strictEqual(u.energy, 1);
});

check("вход на следующий день увеличивает стрик", () => {
  const day1 = Date.UTC(2026, 0, 10, 8); // условное время в UTC
  const u = freshUser();
  logic.registerDailyLogin(u, day1);
  const day2 = day1 + 24 * 60 * 60 * 1000;
  const res = logic.registerDailyLogin(u, day2);
  assert.strictEqual(res.streak, 2);
});

check("пропуск дня обнуляет стрик до 1", () => {
  const day1 = Date.UTC(2026, 0, 10, 8);
  const u = freshUser();
  logic.registerDailyLogin(u, day1);
  const day3 = day1 + 3 * 24 * 60 * 60 * 1000; // пропустили день
  const res = logic.registerDailyLogin(u, day3);
  assert.strictEqual(res.streak, 1);
});

check("повторный вызов в тот же день не даёт повторный бонус", () => {
  const day1 = Date.UTC(2026, 0, 10, 8);
  const u = freshUser();
  logic.registerDailyLogin(u, day1);
  const sameDayLater = day1 + 5 * 60 * 60 * 1000;
  const res = logic.registerDailyLogin(u, sameDayLater);
  assert.strictEqual(res.isNewDay, false);
  assert.strictEqual(res.bonusEnergy, 0);
});

check("нельзя начать матч без энергии", () => {
  const u = freshUser({ energy: 0 });
  assert.strictEqual(logic.canStartMatch(u), false);
  assert.throws(() => logic.startMatch(u), /NOT_ENOUGH_ENERGY/);
});

check("матч тратит 1 энергию и выдаёт токен", () => {
  const u = freshUser({ energy: 3 });
  const token = logic.startMatch(u, Date.now());
  assert.strictEqual(u.energy, 2);
  assert.ok(token.length > 5);
  assert.strictEqual(u.activeMatch.token, token);
});

check("идеальный матч (5/5) поднимает уровень", () => {
  const u = freshUser({ energy: 3, level: 1 });
  const now = Date.now();
  const token = logic.startMatch(u, now);
  const res = logic.submitMatchResult(u, token, 5, now + 1000);
  assert.strictEqual(res.perfect, true);
  assert.strictEqual(u.level, 2);
});

check("неидеальный матч не поднимает уровень", () => {
  const u = freshUser({ energy: 3, level: 4 });
  const now = Date.now();
  const token = logic.startMatch(u, now);
  const res = logic.submitMatchResult(u, token, 3, now + 1000);
  assert.strictEqual(res.perfect, false);
  assert.strictEqual(u.level, 4);
});

check("неверный токен матча отклоняется", () => {
  const u = freshUser({ energy: 3 });
  logic.startMatch(u, Date.now());
  assert.throws(() => logic.submitMatchResult(u, "чужой-токен", 5), /INVALID_MATCH_TOKEN/);
});

check("просроченный матч отклоняется", () => {
  const u = freshUser({ energy: 3 });
  const now = Date.now();
  const token = logic.startMatch(u, now);
  assert.throws(
    () => logic.submitMatchResult(u, token, 5, now + logic.MATCH_TOKEN_TTL_MS + 1000),
    /MATCH_EXPIRED/
  );
});

check("количество голов не может выйти за пределы 0..shotsPerMatch", () => {
  const u = freshUser({ energy: 3 });
  const now = Date.now();
  const token = logic.startMatch(u, now);
  const res = logic.submitMatchResult(u, token, 999, now + 500);
  assert.strictEqual(res.goals, logic.SHOTS_PER_MATCH);
});

check("сложность вратаря растёт с уровнем", () => {
  const d1 = logic.getKeeperDifficulty(1);
  const d10 = logic.getKeeperDifficulty(10);
  const d30 = logic.getKeeperDifficulty(30);
  assert.ok(d10.coverage > d1.coverage);
  assert.ok(d30.coverage > d10.coverage);
  assert.ok(d10.reactionMs < d1.reactionMs);
});

check("лидерборд сортирует по недельным и общим голам", () => {
  const now = Date.now();
  const wk = logic.weekKey(now);
  const users = [
    { id: "a", firstName: "Аня", weekGoals: 10, totalGoals: 40, weekKey: wk },
    { id: "b", firstName: "Боря", weekGoals: 25, totalGoals: 30, weekKey: wk },
    { id: "c", firstName: "Вика", weekGoals: 5, totalGoals: 5, weekKey: "старая-неделя" },
  ];
  const board = logic.buildLeaderboard(users, now);
  assert.strictEqual(board.week[0].name, "Боря");
  assert.strictEqual(board.allTime[0].name, "Аня");
  // у Вики устаревший weekKey — её недельный счёт должен обнулиться в отображении
  const vika = board.week.find((r) => r.name === "Вика");
  assert.strictEqual(vika.score, 0);
});

check("бонус за новость даёт энергию сверх обычного максимума", () => {
  const now = Date.now();
  const u = freshUser({ energy: 8, maxEnergy: 8 });
  const res = logic.claimNewsBonus(u, now);
  assert.strictEqual(res.granted, true);
  assert.strictEqual(u.energy, 10); // 8 + NEWS_BONUS_ENERGY(2), потолок 8+2=10
});

check("бонус за новость не выдаётся дважды в один день", () => {
  const now = Date.now();
  const u = freshUser({ energy: 5, maxEnergy: 8 });
  logic.claimNewsBonus(u, now);
  const res2 = logic.claimNewsBonus(u, now + 60 * 1000);
  assert.strictEqual(res2.granted, false);
  assert.strictEqual(res2.added, 0);
});

check("бонус за новость снова доступен на следующий день", () => {
  const day1 = Date.UTC(2026, 0, 10, 8);
  const u = freshUser({ energy: 5, maxEnergy: 8 });
  logic.claimNewsBonus(u, day1);
  assert.strictEqual(logic.isNewsBonusAvailable(u, day1), false);
  const day2 = day1 + 24 * 60 * 60 * 1000;
  assert.strictEqual(logic.isNewsBonusAvailable(u, day2), true);
});

check("бонусы за VK и MAX работают независимо друг от друга и от новости", () => {
  const now = Date.now();
  const u = freshUser({ energy: 5, maxEnergy: 8 });
  const vkRes = logic.claimVkBonus(u, now);
  assert.strictEqual(vkRes.granted, true);
  assert.strictEqual(u.energy, 7);
  // новость и MAX всё ещё доступны — забор VK их не трогает
  assert.strictEqual(logic.isNewsBonusAvailable(u, now), true);
  assert.strictEqual(logic.isMaxBonusAvailable(u, now), true);
  assert.strictEqual(logic.isVkBonusAvailable(u, now), false);

  const maxRes = logic.claimMaxBonus(u, now);
  assert.strictEqual(maxRes.granted, true);
  assert.strictEqual(u.energy, 9); // 7 + 2, потолок 8+2=10

  const newsRes = logic.claimNewsBonus(u, now);
  assert.strictEqual(newsRes.granted, true);
  assert.strictEqual(u.energy, 10); // упёрлись в потолок 8+2

  // повторно в тот же день — уже нельзя ни один из трёх
  assert.strictEqual(logic.claimVkBonus(u, now).granted, false);
  assert.strictEqual(logic.claimMaxBonus(u, now).granted, false);
  assert.strictEqual(logic.claimNewsBonus(u, now).granted, false);
});

check("безлимитный день позволяет играть без энергии и не тратит её", () => {
  const now = Date.now();
  const u = freshUser({ energy: 0 });
  const settings = { matchDayKey: logic.dateKey(now) };
  const unlimited = logic.isMatchDayActive(settings, now);
  assert.strictEqual(unlimited, true);
  assert.strictEqual(logic.canStartMatch(u, unlimited), true);
  const token = logic.startMatch(u, now, unlimited);
  assert.strictEqual(u.energy, 0); // энергия не потрачена
  assert.ok(token);
});

check("вне дня матча безлимит не активен", () => {
  const now = Date.now();
  const settings = { matchDayKey: null };
  assert.strictEqual(logic.isMatchDayActive(settings, now), false);
});

check("имена соперников циклически повторяются с пометкой круга", () => {
  const n = logic.OPPONENTS.length;
  assert.strictEqual(logic.getOpponentName(1), logic.OPPONENTS[0]);
  assert.strictEqual(logic.getOpponentName(n), logic.OPPONENTS[n - 1]);
  assert.ok(logic.getOpponentName(n + 1).includes("круг 2"));
  assert.ok(logic.getOpponentName(n + 1).includes(logic.OPPONENTS[0]));
});

check("режим чередуется по чётности уровня", () => {
  assert.strictEqual(logic.getModeForLevel(1), "attack");
  assert.strictEqual(logic.getModeForLevel(2), "defense");
  assert.strictEqual(logic.getModeForLevel(3), "attack");
  assert.strictEqual(logic.getModeForLevel(30), "defense");
});

check("матч сохраняет режим в activeMatch и возвращает его в результате", () => {
  const u = freshUser({ energy: 3, level: 2 }); // level 2 -> defense
  const now = Date.now();
  const token = logic.startMatch(u, now);
  assert.strictEqual(u.activeMatch.mode, "defense");
  const res = logic.submitMatchResult(u, token, 5, now + 1000);
  assert.strictEqual(res.playedMode, "defense");
});

check("достижение «Первый гол» выдаётся за первый забитый гол в атаке", () => {
  const u = freshUser({ energy: 3, level: 1 });
  const now = Date.now();
  const token = logic.startMatch(u, now);
  const res = logic.submitMatchResult(u, token, 1, now + 500);
  assert.ok(res.newAchievements.includes("first_goal"));
});

check("достижение «Хет-трик» выдаётся за 3+ гола за матч в атаке", () => {
  const u = freshUser({ energy: 3, level: 1 });
  const now = Date.now();
  const token = logic.startMatch(u, now);
  const res = logic.submitMatchResult(u, token, 3, now + 500);
  assert.ok(res.newAchievements.includes("hat_trick"));
});

check("достижение «Идеальный матч» и «Стена» зависят от режима", () => {
  const attacker = freshUser({ energy: 3, level: 1 }); // attack
  const now = Date.now();
  let token = logic.startMatch(attacker, now);
  let res = logic.submitMatchResult(attacker, token, 5, now + 500);
  assert.ok(res.newAchievements.includes("perfect_match"));
  assert.ok(!res.newAchievements.includes("keeper_wall"));

  const keeper = freshUser({ energy: 3, level: 2 }); // defense
  token = logic.startMatch(keeper, now);
  res = logic.submitMatchResult(keeper, token, 5, now + 500);
  assert.ok(res.newAchievements.includes("keeper_wall"));
  assert.ok(!res.newAchievements.includes("perfect_match"));
});

check("достижения не выдаются повторно", () => {
  const u = freshUser({ energy: 5, level: 1 });
  const now = Date.now();
  let token = logic.startMatch(u, now);
  const res1 = logic.submitMatchResult(u, token, 1, now + 500);
  assert.ok(res1.newAchievements.includes("first_goal"));
  token = logic.startMatch(u, now + 1000);
  const res2 = logic.submitMatchResult(u, token, 1, now + 1500);
  assert.ok(!res2.newAchievements.includes("first_goal"));
});

check("достижения за стрик и уровень срабатывают через checkAchievements", () => {
  const u = freshUser({ streak: 7, level: 20, totalGoals: 200 });
  const newly = logic.checkAchievements(u, {});
  assert.ok(newly.includes("streak_3"));
  assert.ok(newly.includes("streak_7"));
  assert.ok(newly.includes("level_10"));
  assert.ok(newly.includes("level_20"));
  assert.ok(newly.includes("goals_50"));
  assert.ok(newly.includes("goals_200"));
});

check("именные уровни сложности разбиты на три равные трети", () => {
  assert.strictEqual(logic.getDifficultyTierName(1), "Лёгкий");
  assert.strictEqual(logic.getDifficultyTierName(10), "Лёгкий");
  assert.strictEqual(logic.getDifficultyTierName(11), "Средний");
  assert.strictEqual(logic.getDifficultyTierName(20), "Средний");
  assert.strictEqual(logic.getDifficultyTierName(21), "Мастер");
  assert.strictEqual(logic.getDifficultyTierName(30), "Мастер");
});

check("getKeeperDifficulty включает название текущего уровня сложности", () => {
  assert.strictEqual(logic.getKeeperDifficulty(5).tier, "Лёгкий");
  assert.strictEqual(logic.getKeeperDifficulty(15).tier, "Средний");
  assert.strictEqual(logic.getKeeperDifficulty(25).tier, "Мастер");
});

check("переход на новый уровень сложности отмечается флагом tierChanged", () => {
  const u = freshUser({ energy: 3, level: 10 }); // level 10 -> attack, ещё "Лёгкий"
  const now = Date.now();
  const token = logic.startMatch(u, now);
  const res = logic.submitMatchResult(u, token, 5, now + 500);
  assert.strictEqual(res.newLevel, 11);
  assert.strictEqual(res.tierChanged, true);
  assert.strictEqual(res.tierName, "Средний");
});

check("без смены уровня сложности флаг tierChanged не срабатывает", () => {
  const u = freshUser({ energy: 3, level: 3 });
  const now = Date.now();
  const token = logic.startMatch(u, now);
  const res = logic.submitMatchResult(u, token, 5, now + 500);
  assert.strictEqual(res.newLevel, 4);
  assert.strictEqual(res.tierChanged, false);
  assert.strictEqual(res.tierName, "Лёгкий");
});

check("дуэль создаётся с фиксированной сложностью и без соперника", () => {
  const duel = logic.createDuel("100", "Вадим", Date.now());
  assert.strictEqual(duel.creatorId, "100");
  assert.strictEqual(duel.opponentId, null);
  assert.strictEqual(duel.shotsPerDuel, logic.DUEL_SHOTS);
});

check("создатель дуэли определяется как creator, второй как opponent-candidate", () => {
  const duel = logic.createDuel("100", "Вадим");
  assert.strictEqual(logic.roleForUser(duel, "100"), "creator");
  assert.strictEqual(logic.roleForUser(duel, "200"), "opponent-candidate");
});

check("третий человек, зашедший по ссылке, становится зрителем", () => {
  const duel = logic.createDuel("100", "Вадим");
  logic.startDuelAttempt(duel, "200", "Кирилл"); // занимает место opponent
  assert.strictEqual(logic.roleForUser(duel, "300"), "spectator");
  assert.throws(() => logic.startDuelAttempt(duel, "300", "Андрей"), /DUEL_FULL/);
});

check("оба играют свою попытку — победитель определяется по числу голов", () => {
  const duel = logic.createDuel("100", "Вадим");
  const now = Date.now();
  const { token: t1 } = logic.startDuelAttempt(duel, "100", "Вадим", now);
  const r1 = logic.submitDuelResult(duel, "100", t1, 12, now + 1000);
  assert.strictEqual(r1.finished, false); // соперник ещё не играл

  const { token: t2 } = logic.startDuelAttempt(duel, "200", "Кирилл", now + 2000);
  const r2 = logic.submitDuelResult(duel, "200", t2, 15, now + 3000);
  assert.strictEqual(r2.finished, true);
  assert.strictEqual(r2.winner, "opponent"); // у Кирилла больше голов
});

check("ничья в дуэли определяется корректно", () => {
  const duel = logic.createDuel("100", "Вадим");
  const now = Date.now();
  const { token: t1 } = logic.startDuelAttempt(duel, "100", "Вадим", now);
  logic.submitDuelResult(duel, "100", t1, 10, now);
  const { token: t2 } = logic.startDuelAttempt(duel, "200", "Кирилл", now);
  const r2 = logic.submitDuelResult(duel, "200", t2, 10, now);
  assert.strictEqual(r2.winner, "draw");
});

check("нельзя сыграть в дуэли дважды за одну и ту же роль", () => {
  const duel = logic.createDuel("100", "Вадим");
  const now = Date.now();
  const { token } = logic.startDuelAttempt(duel, "100", "Вадим", now);
  logic.submitDuelResult(duel, "100", token, 5, now);
  assert.throws(() => logic.startDuelAttempt(duel, "100", "Вадим", now + 1000), /ALREADY_PLAYED/);
});

check("неверный токен дуэли отклоняется", () => {
  const duel = logic.createDuel("100", "Вадим");
  logic.startDuelAttempt(duel, "100", "Вадим");
  assert.throws(() => logic.submitDuelResult(duel, "100", "чужой-токен", 5), /INVALID_DUEL_TOKEN/);
});

check("лидерборд отдаёт photoUrl игрока (или null, если фото нет)", () => {
  const u1 = freshUser({ id: "1", firstName: "Вадим", weekGoals: 10, totalGoals: 10, photoUrl: "https://t.me/photo1.jpg" });
  const u2 = freshUser({ id: "2", firstName: "Кирилл", weekGoals: 5, totalGoals: 5 });
  const board = logic.buildLeaderboard([u1, u2]);
  assert.strictEqual(board.week[0].photoUrl, "https://t.me/photo1.jpg");
  assert.strictEqual(board.week[1].photoUrl, null);
});

check("дорожка соперников показывает пройденных, текущего и предстоящих", () => {
  const road = logic.buildOpponentRoad(5, 2, 3);
  const levels = road.map((r) => r.level);
  assert.deepStrictEqual(levels, [3, 4, 5, 6, 7, 8]);
  assert.strictEqual(road.find((r) => r.level === 3).status, "done");
  assert.strictEqual(road.find((r) => r.level === 5).status, "current");
  assert.strictEqual(road.find((r) => r.level === 8).status, "upcoming");
});

check("дорожка соперников не выходит за начало и конец списка уровней", () => {
  const roadStart = logic.buildOpponentRoad(1, 2, 3);
  assert.strictEqual(roadStart[0].level, 1);
  const roadEnd = logic.buildOpponentRoad(logic.MAX_LEVEL, 2, 3);
  assert.strictEqual(roadEnd[roadEnd.length - 1].level, logic.MAX_LEVEL);
});

check("тренировка не тратит энергию, не меняет уровень и не пишется в статистику", () => {
  const user = freshUser({ energy: 0, maxEnergy: 8, level: 3, totalGoals: 10, weekGoals: 10 });
  const { token, mode } = logic.startTrainingMatch(user, "defense");
  assert.strictEqual(mode, "defense");
  const result = logic.submitTrainingResult(user, token, 5);
  assert.strictEqual(result.perfect, true);
  assert.strictEqual(result.mode, "defense");
  // Энергия, уровень и голы не должны были измениться от тренировки.
  assert.strictEqual(user.energy, 0);
  assert.strictEqual(user.level, 3);
  assert.strictEqual(user.totalGoals, 10);
  assert.strictEqual(user.weekGoals, 10);
});

check("тренировку нельзя завершить неверным токеном", () => {
  const user = freshUser({ level: 1 });
  logic.startTrainingMatch(user, "attack");
  assert.throws(() => logic.submitTrainingResult(user, "чужой-токен", 5), /INVALID_TRAINING_TOKEN/);
});

check("режим тренировки по умолчанию — атака, если передали что-то незнакомое", () => {
  const user = freshUser({ level: 1 });
  const { mode } = logic.startTrainingMatch(user, "что-то странное");
  assert.strictEqual(mode, "attack");
});

check("isWebGuestId отличает гостевой веб-id от Telegram-id", () => {
  assert.strictEqual(logic.isWebGuestId("web_abc123"), true);
  assert.strictEqual(logic.isWebGuestId("123456789"), false);
  assert.strictEqual(logic.isWebGuestId(null), false);
});

check("buildStats считает игроков по источнику входа и активности", () => {
  const now = Date.now();
  const todayKey = logic.dateKey(now);
  const users = [
    freshUser({ id: "111", firstName: "Телеграмщик", totalGoals: 20, lastPlayedDate: todayKey, createdAt: now }),
    freshUser({ id: "web_abc", firstName: "Гость", totalGoals: 5, lastPlayedDate: todayKey }),
    freshUser({ id: "222", firstName: "Старичок", totalGoals: 50, lastPlayedDate: null, createdAt: now - 30 * 86400000 }),
  ];
  const duel = logic.createDuel("111", "Телеграмщик", now);
  logic.startDuelAttempt(duel, "111", "Телеграмщик", now);
  logic.submitDuelResult(duel, "111", duel.creatorToken, 10, now);
  const stats = logic.buildStats(users, [duel], now);
  assert.strictEqual(stats.totalPlayers, 3);
  assert.strictEqual(stats.fromTelegram, 2);
  assert.strictEqual(stats.fromWeb, 1);
  assert.strictEqual(stats.playedToday, 2);
  assert.strictEqual(stats.newToday, 1);
  assert.strictEqual(stats.totalGoalsAllTime, 75);
  assert.strictEqual(stats.totalDuels, 1);
  assert.strictEqual(stats.finishedDuels, 0); // только одна сторона сыграла
  assert.strictEqual(stats.topActive[0].name, "Старичок"); // больше всех голов
});

check("ensureCurrentDay замораживает вчерашний итог и обнуляет счёт нового дня", () => {
  const day1 = Date.parse("2026-07-20T10:00:00Z"); // с учётом CLUB_UTC_OFFSET_HOURS это всё ещё 20-е число
  const u = freshUser({ dayGoals: 0, dayKey: null, prevDayGoals: 0, prevDayKey: null });
  logic.ensureCurrentDay(u, day1);
  assert.strictEqual(u.dayKey, logic.dateKey(day1));
  assert.strictEqual(u.dayGoals, 0);
  assert.strictEqual(u.prevDayKey, null); // это был самый первый визит — вчера ещё не было

  u.dayGoals = 4; // как будто за день забил 4 гола
  const day2 = day1 + 26 * 60 * 60 * 1000; // на следующий клубный день
  logic.ensureCurrentDay(u, day2);
  assert.strictEqual(u.dayKey, logic.dateKey(day2));
  assert.strictEqual(u.dayGoals, 0); // счётчик нового дня обнулён
  assert.strictEqual(u.prevDayKey, logic.dateKey(day1)); // а итог прошлого дня заморожен
  assert.strictEqual(u.prevDayGoals, 4);

  // Повторный вызов в тот же день ничего не портит (идемпотентность).
  logic.ensureCurrentDay(u, day2 + 60 * 1000);
  assert.strictEqual(u.prevDayGoals, 4);
});

check("submitMatchResult копит dayGoals так же, как weekGoals/totalGoals", () => {
  const now = Date.now();
  const u = freshUser({ energy: 5, maxEnergy: 5, level: 5 });
  const token = logic.startMatch(u, now);
  const res = logic.submitMatchResult(u, token, 3, now);
  assert.strictEqual(res.goals, 3);
  assert.strictEqual(u.dayGoals, 3);
  assert.strictEqual(u.dayKey, logic.dateKey(now));
});

check("buildDailyLeaders находит вчерашнего лидера по числу голов", () => {
  const now = Date.now();
  const yKey = logic.yesterdayKey(now);
  const users = [
    freshUser({ id: "111", firstName: "Первый", prevDayKey: yKey, prevDayGoals: 7 }),
    freshUser({ id: "222", firstName: "Второй", prevDayKey: yKey, prevDayGoals: 12 }),
    freshUser({ id: "333", firstName: "Позавчерашний", prevDayKey: "2000-01-01", prevDayGoals: 999 }),
    freshUser({ id: "444", firstName: "Ноль", prevDayKey: yKey, prevDayGoals: 0 }),
  ];
  const top1 = logic.buildDailyLeaders(users, now, 1);
  assert.strictEqual(top1.length, 1);
  assert.strictEqual(top1[0].id, "222");
  assert.strictEqual(top1[0].goals, 12);
  assert.strictEqual(top1[0].dayKey, yKey);

  const top3 = logic.buildDailyLeaders(users, now, 3);
  assert.deepStrictEqual(top3.map((l) => l.id), ["222", "111"]); // "444" с нулём голов и "333" со старым днём не входят
});

check("buildDailyLeaders возвращает пустой список, если вчера никто не играл", () => {
  const now = Date.now();
  const users = [freshUser({ id: "1", prevDayKey: "2000-01-01", prevDayGoals: 5 })];
  assert.deepStrictEqual(logic.buildDailyLeaders(users, now, 1), []);
});

console.log(`\n${passed} тест(ов) пройдено успешно.`);
