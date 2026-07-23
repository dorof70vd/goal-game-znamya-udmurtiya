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
  const u = freshUser({ energy: 5, lastEnergyTs: Date.now() - 10 * 60 * 60 * 1000 });
  logic.applyEnergyRegen(u);
  assert.strictEqual(u.energy, 5);
});

check("энергия восстанавливается по 1 в час", () => {
  const now = Date.now();
  const u = freshUser({ energy: 2, maxEnergy: 5, lastEnergyTs: now - 3 * 60 * 60 * 1000 });
  logic.applyEnergyRegen(u, now);
  assert.strictEqual(u.energy, 5); // 2 + 3, capped at 5
});

check("energy регенерация не превышает максимум и не теряет остаток времени", () => {
  const now = Date.now();
  const u = freshUser({ energy: 3, maxEnergy: 5, lastEnergyTs: now - 90 * 60 * 1000 }); // 1.5 часа
  logic.applyEnergyRegen(u, now);
  assert.strictEqual(u.energy, 4); // только 1 полный час засчитан
  const msLeft = logic.msUntilNextEnergy(u, now);
  assert.ok(msLeft > 0 && msLeft <= 30 * 60 * 1000 + 1000);
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

console.log(`\n${passed} тест(ов) пройдено успешно.`);
