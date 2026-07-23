// Чистая игровая логика (энергия, стрик, лидерборд, сложность).
// Вынесена отдельно от Express/бота специально, чтобы её можно было
// протестировать без поднятия сервера (см. game-logic.test.js).

const ENERGY_MAX = 8; // сколько попыток (матчей) доступно "с нуля"
const ENERGY_REGEN_MS = 60 * 60 * 1000; // 1 энергия в час
const SHOTS_PER_MATCH = 5; // ударов в одном матче
const MAX_LEVEL = 30; // условное число "соперников" по календарю лиги
const MATCH_TOKEN_TTL_MS = 10 * 60 * 1000; // матч живёт максимум 10 минут

// Бонус за прочтение новости клуба: даёт дополнительные попытки СВЕРХ
// обычного максимума (эффективный потолок в этот день — ENERGY_MAX + этот бонус).
const NEWS_BONUS_ENERGY = 2;
const NEWS_BONUS_CEILING_EXTRA = 2;

// Клуб играет в зоне UTC+4 (Удмуртия/Самара) — считаем "новый день" и
// "новую неделю" по этому смещению, а не по времени сервера.
const CLUB_UTC_OFFSET_HOURS = 4;

function shiftedDate(ts) {
  return new Date(ts + CLUB_UTC_OFFSET_HOURS * 60 * 60 * 1000);
}

function dateKey(ts) {
  const d = shiftedDate(ts);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// ISO-подобный ключ недели: год + номер недели (пн-вс), без внешних библиотек.
function weekKey(ts) {
  const d = shiftedDate(ts);
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (date.getUTCDay() + 6) % 7; // 0 = понедельник
  date.setUTCDate(date.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(
    ((date.getTime() - firstThursday.getTime()) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7
  );
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function daysBetweenKeys(prevKey, curKey) {
  if (!prevKey) return Infinity;
  const [py, pm, pd] = prevKey.split("-").map(Number);
  const [cy, cm, cd] = curKey.split("-").map(Number);
  const prev = Date.UTC(py, pm - 1, pd);
  const cur = Date.UTC(cy, cm - 1, cd);
  return Math.round((cur - prev) / 86400000);
}

/** Восстанавливает энергию по прошедшему времени. Мутирует и возвращает user. */
function applyEnergyRegen(user, now = Date.now()) {
  if (user.energy >= user.maxEnergy) {
    user.lastEnergyTs = now;
    return user;
  }
  const elapsed = now - user.lastEnergyTs;
  const regenerated = Math.floor(elapsed / ENERGY_REGEN_MS);
  if (regenerated > 0) {
    user.energy = Math.min(user.maxEnergy, user.energy + regenerated);
    // Остаток времени переносим, чтобы не терять "накопленные" минуты
    user.lastEnergyTs = user.lastEnergyTs + regenerated * ENERGY_REGEN_MS;
  }
  return user;
}

function msUntilNextEnergy(user, now = Date.now()) {
  if (user.energy >= user.maxEnergy) return 0;
  const elapsed = now - user.lastEnergyTs;
  const remainder = ENERGY_REGEN_MS - (elapsed % ENERGY_REGEN_MS);
  return remainder;
}

/**
 * Ежедневный вход: считает стрик и выдаёт бонусную энергию за визит в новый день.
 * Возвращает { streak, bonusEnergy, isNewDay }.
 */
function registerDailyLogin(user, now = Date.now()) {
  const todayKey = dateKey(now);
  if (user.lastPlayedDate === todayKey) {
    return { streak: user.streak, bonusEnergy: 0, isNewDay: false };
  }
  const gap = daysBetweenKeys(user.lastPlayedDate, todayKey);
  let bonusEnergy = 0;
  if (gap === 1) {
    user.streak += 1;
    bonusEnergy = 1;
  } else {
    // пропуск дня (или первый визит) — стрик начинается заново
    user.streak = 1;
    bonusEnergy = 1;
  }
  user.energy = Math.min(user.maxEnergy, user.energy + bonusEnergy);
  user.lastPlayedDate = todayKey;
  return { streak: user.streak, bonusEnergy, isNewDay: true };
}

/**
 * Бонус за прочтение новости клуба: +NEWS_BONUS_ENERGY энергии, один раз в день,
 * может превысить обычный максимум (но не бесконечно — есть отдельный потолок).
 * Возвращает { granted, added, energy }.
 */
function claimNewsBonus(user, now = Date.now()) {
  const todayKey = dateKey(now);
  if (user.lastNewsBonusDate === todayKey) {
    return { granted: false, added: 0, energy: user.energy };
  }
  const ceiling = user.maxEnergy + NEWS_BONUS_CEILING_EXTRA;
  const before = user.energy;
  user.energy = Math.min(ceiling, user.energy + NEWS_BONUS_ENERGY);
  user.lastNewsBonusDate = todayKey;
  return { granted: true, added: user.energy - before, energy: user.energy };
}

function isNewsBonusAvailable(user, now = Date.now()) {
  return user.lastNewsBonusDate !== dateKey(now);
}

/** Активен ли сегодня безлимитный режим (день настоящего матча клуба). */
function isMatchDayActive(settings, now = Date.now()) {
  return Boolean(settings && settings.matchDayKey === dateKey(now));
}

/** Сбрасывает недельный счёт, если наступила новая неделя. Мутирует user. */
function ensureCurrentWeek(user, now = Date.now()) {
  const curWeek = weekKey(now);
  if (user.weekKey !== curWeek) {
    user.weekKey = curWeek;
    user.weekGoals = 0;
  }
  return user;
}

/** Параметры сложности вратаря на заданном уровне. */
function getKeeperDifficulty(level) {
  const lvl = Math.max(1, Math.min(MAX_LEVEL, level));
  // Реакция вратаря (мс на перемещение к точке удара) — чем меньше, тем сложнее.
  const reactionMs = Math.max(220, 620 - lvl * 13);
  // Доля ворот, которую вратарь способен "закрыть" одним броском (0..1).
  const coverage = Math.min(0.85, 0.35 + lvl * 0.016);
  // Случайные финты (вратарь иногда стартует в неверную сторону)
  const feintChance = Math.min(0.35, lvl * 0.01);
  return { level: lvl, reactionMs, coverage, feintChance };
}

function canStartMatch(user, unlimited = false) {
  return unlimited || user.energy >= 1;
}

function startMatch(user, now = Date.now(), unlimited = false) {
  if (!canStartMatch(user, unlimited)) {
    throw new Error("NOT_ENOUGH_ENERGY");
  }
  if (!unlimited) {
    user.energy -= 1;
  }
  const token = `${user.id}.${now}.${Math.random().toString(36).slice(2, 10)}`;
  user.activeMatch = { token, createdAt: now, level: user.level, unlimited };
  return token;
}

/**
 * Принимает результат матча от клиента.
 * goals — число забитых голов (0..SHOTS_PER_MATCH) за этот матч.
 */
function submitMatchResult(user, token, goals, now = Date.now()) {
  const match = user.activeMatch;
  if (!match || match.token !== token) {
    throw new Error("INVALID_MATCH_TOKEN");
  }
  if (now - match.createdAt > MATCH_TOKEN_TTL_MS) {
    user.activeMatch = null;
    throw new Error("MATCH_EXPIRED");
  }
  const safeGoals = Math.max(0, Math.min(SHOTS_PER_MATCH, Math.round(goals)));

  ensureCurrentWeek(user, now);
  user.totalGoals += safeGoals;
  user.weekGoals += safeGoals;
  user.bestScore = Math.max(user.bestScore, safeGoals);

  const perfect = safeGoals === SHOTS_PER_MATCH;
  if (perfect && user.level < MAX_LEVEL) {
    user.level += 1;
  }
  user.activeMatch = null;

  return {
    goals: safeGoals,
    perfect,
    newLevel: user.level,
    totalGoals: user.totalGoals,
    weekGoals: user.weekGoals,
    bestScore: user.bestScore,
  };
}

function buildLeaderboard(users, now = Date.now(), limit = 20) {
  const curWeek = weekKey(now);
  const withCurrentWeek = users.map((u) => ({
    ...u,
    weekGoals: u.weekKey === curWeek ? u.weekGoals : 0,
  }));

  const byWeek = [...withCurrentWeek]
    .sort((a, b) => b.weekGoals - a.weekGoals)
    .slice(0, limit)
    .map((u) => ({ id: u.id, name: u.firstName || u.username || "Болельщик", score: u.weekGoals }));

  const byAllTime = [...withCurrentWeek]
    .sort((a, b) => b.totalGoals - a.totalGoals)
    .slice(0, limit)
    .map((u) => ({ id: u.id, name: u.firstName || u.username || "Болельщик", score: u.totalGoals }));

  return { week: byWeek, allTime: byAllTime, weekKey: curWeek };
}

module.exports = {
  ENERGY_MAX,
  ENERGY_REGEN_MS,
  SHOTS_PER_MATCH,
  MAX_LEVEL,
  MATCH_TOKEN_TTL_MS,
  CLUB_UTC_OFFSET_HOURS,
  NEWS_BONUS_ENERGY,
  NEWS_BONUS_CEILING_EXTRA,
  dateKey,
  weekKey,
  applyEnergyRegen,
  msUntilNextEnergy,
  registerDailyLogin,
  claimNewsBonus,
  isNewsBonusAvailable,
  isMatchDayActive,
  ensureCurrentWeek,
  getKeeperDifficulty,
  canStartMatch,
  startMatch,
  submitMatchResult,
  buildLeaderboard,
};
