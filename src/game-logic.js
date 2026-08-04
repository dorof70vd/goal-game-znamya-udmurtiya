// Чистая игровая логика (энергия, стрик, лидерборд, сложность).
// Вынесена отдельно от Express/бота специально, чтобы её можно было
// протестировать без поднятия сервера (см. game-logic.test.js).

const ENERGY_MAX = 8; // сколько попыток (матчей) доступно "с нуля"
const ENERGY_REGEN_MS = 30 * 60 * 1000; // 1 энергия за 30 минут
const SHOTS_PER_MATCH = 5; // ударов в одном матче
const MAX_LEVEL = 30; // условное число "соперников" по календарю лиги
const MATCH_TOKEN_TTL_MS = 10 * 60 * 1000; // матч живёт максимум 10 минут

// Бонус за прочтение новости клуба: даёт дополнительные попытки СВЕРХ
// обычного максимума (эффективный потолок в этот день — ENERGY_MAX + этот бонус).
const NEWS_BONUS_ENERGY = 2;
const NEWS_BONUS_CEILING_EXTRA = 2;

// Реферальная механика — приглашение засчитывается ПОСТОЯННОЙ прибавкой к
// максимуму энергии (а не разовым бонусом сверх потолка, как новость/VK/MAX
// выше) — так игрок реально чувствует ценность приглашения, а не просто
// "ещё немного попыток на сегодня". У инвайтера есть потолок (иначе в теории
// можно бесконечно раздувать максимум фейковыми приглашениями), у нового
// друга — разовая прибавка при первом входе.
const REFERRAL_INVITER_ENERGY_BONUS = 1; // +1 к maxEnergy инвайтеру за каждого успешного друга
const REFERRAL_INVITER_MAX_BONUSES = 4; // не больше 4 таких прибавок за всё время (потолок +4)
const REFERRAL_INVITEE_ENERGY_BONUS = 1; // разовая прибавка тому, кого пригласили

// Конкурс дня (с реальным призом от клуба) — фиксированное окно 24 часа с
// момента, когда администратор его запускает командой /contest в боте.
const CONTEST_DURATION_MS = 24 * 60 * 60 * 1000;

// Клуб играет в зоне UTC+4 (Удмуртия/Самара) — считаем "новый день" и
// "новую неделю" по этому смещению, а не по времени сервера.
const CLUB_UTC_OFFSET_HOURS = 4;

// Реальные соперники по Высшей лиге (сезон 2025-2026), вместо "Соперник №N" —
// добавляет азарта "дойти до финала" списка. Цикл повторяется с пометкой "круг N".
const OPPONENTS = [
  "Маяк",
  "Академия «Уральский Трубник»",
  "Никельщик",
  "Волга-М",
  "Ак Барс-Динамо-2",
  "Локомотив",
  "Кировец",
];

function getOpponentName(level) {
  const lvl = Math.max(1, Math.round(level));
  const idx = (lvl - 1) % OPPONENTS.length;
  const lap = Math.floor((lvl - 1) / OPPONENTS.length);
  const name = OPPONENTS[idx];
  return lap > 0 ? `${name} (круг ${lap + 1})` : name;
}

// Второй режим игры чередуется по чётности уровня, чтобы не приедалось одно
// и то же: нечётные уровни — "Забей гол" (атака), чётные — "Вратарь" (защита).
function getModeForLevel(level) {
  const lvl = Math.max(1, Math.round(level));
  return lvl % 2 === 0 ? "defense" : "attack";
}

// Достижения/значки — просто отражают уже посчитанные показатели пользователя,
// без отдельного хранения прогресса. Идемпотентны: можно вызывать после
// каждого матча, новыми будут только реально новые значки.
const ACHIEVEMENTS = [
  { id: "first_goal", title: "Первый гол", desc: "Забей свой первый гол в игре." },
  { id: "hat_trick", title: "Хет-трик", desc: "Забей 3 гола за один матч." },
  { id: "perfect_match", title: "Идеальный матч", desc: "Забей все 5 из 5 ударов за один матч." },
  { id: "keeper_wall", title: "Стена", desc: "Отрази все броски соперника в режиме «Вратарь»." },
  { id: "streak_3", title: "Разогрев", desc: "Заходи в игру 3 дня подряд." },
  { id: "streak_7", title: "Неделя с клубом", desc: "Заходи в игру 7 дней подряд." },
  { id: "streak_30", title: "Верный болельщик", desc: "Заходи в игру 30 дней подряд." },
  { id: "level_10", title: "Знаток лиги", desc: "Дойди до 10-го соперника." },
  { id: "level_20", title: "Ветеран", desc: "Дойди до 20-го соперника." },
  { id: "level_max", title: "Чемпион сезона", desc: "Пройди весь список соперников." },
  { id: "level_legend", title: "Легенда", desc: "Пройди дальше 30-го уровня — там, где раньше был потолок сложности." },
  { id: "goals_50", title: "Полсотни", desc: "Забей 50 голов всего (по всем матчам)." },
  { id: "goals_200", title: "Двести", desc: "Забей 200 голов всего (по всем матчам)." },
  { id: "referral_1", title: "Заводила", desc: "Пригласи друга в игру по личной ссылке." },
];

function ensureAchievements(user) {
  if (!Array.isArray(user.achievements)) user.achievements = [];
  return user.achievements;
}

function unlockAchievement(user, id, newlyUnlocked) {
  const list = ensureAchievements(user);
  if (!list.includes(id)) {
    list.push(id);
    newlyUnlocked.push(id);
  }
}

/**
 * Проверяет и выдаёт новые достижения после матча (или входа). matchInfo —
 * необязательные данные о только что сыгранном матче: { goals, mode, perfect }.
 * Возвращает массив id новых значков (пустой, если ничего нового).
 */
function checkAchievements(user, matchInfo = {}) {
  ensureAchievements(user);
  const newly = [];
  const { goals = 0, mode = null, perfect = false } = matchInfo;

  if (mode === "attack") {
    if (goals >= 1) unlockAchievement(user, "first_goal", newly);
    if (goals >= 3) unlockAchievement(user, "hat_trick", newly);
    if (perfect) unlockAchievement(user, "perfect_match", newly);
  } else if (mode === "defense") {
    if (perfect) unlockAchievement(user, "keeper_wall", newly);
  }

  if (user.streak >= 3) unlockAchievement(user, "streak_3", newly);
  if (user.streak >= 7) unlockAchievement(user, "streak_7", newly);
  if (user.streak >= 30) unlockAchievement(user, "streak_30", newly);
  if (user.level >= 10) unlockAchievement(user, "level_10", newly);
  if (user.level >= 20) unlockAchievement(user, "level_20", newly);
  if (user.level >= MAX_LEVEL) unlockAchievement(user, "level_max", newly);
  if (user.level > MAX_LEVEL) unlockAchievement(user, "level_legend", newly);
  if (user.totalGoals >= 50) unlockAchievement(user, "goals_50", newly);
  if (user.totalGoals >= 200) unlockAchievement(user, "goals_200", newly);
  if ((user.referralCount || 0) >= 1) unlockAchievement(user, "referral_1", newly);

  return newly;
}

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

/**
 * Разбирает строку "YYYY-MM-DD HH:MM" (или с "T" вместо пробела), считая её
 * временем клуба (Ижевск/Самара, см. CLUB_UTC_OFFSET_HOURS), и возвращает
 * абсолютный timestamp (мс, UTC). Возвращает null, если строка не подходит
 * под формат. Используется для планирования старта конкурса (/contest_at).
 */
function parseClubDateTime(str) {
  const m = String(str || "").trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]), h = Number(m[4]), mi = Number(m[5]);
  const utcIfLocalWereUtc = Date.UTC(y, mo - 1, d, h, mi);
  if (Number.isNaN(utcIfLocalWereUtc)) return null;
  return utcIfLocalWereUtc - CLUB_UTC_OFFSET_HOURS * 60 * 60 * 1000;
}

/** Форматирует timestamp как "DD.MM.YYYY HH:MM (время Ижевска)" — для сообщений бота. */
function formatClubDateTime(ts) {
  const d = shiftedDate(ts);
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const yyyy = d.getUTCFullYear();
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const min = String(d.getUTCMinutes()).padStart(2, "0");
  return `${dd}.${mm}.${yyyy} ${hh}:${min} (время Ижевска)`;
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
  // Текущий streak может потом упасть (пропустил день) — а bestStreak хранит
  // рекорд навсегда, именно он и нужен "залу славы" (см. buildHallOfFame).
  user.bestStreak = Math.max(user.bestStreak || 0, user.streak);
  return { streak: user.streak, bonusEnergy, isNewDay: true };
}

/**
 * Общий механизм "бонус за переход по ссылке клуба" (новость, VK, MAX — что
 * угодно): +NEWS_BONUS_ENERGY энергии, один раз в день на конкретное поле,
 * может превысить обычный максимум (но не бесконечно — есть отдельный потолок).
 * Разные площадки хранят свою дату отдельным полем на user, поэтому бонусы
 * независимы друг от друга — можно забрать за новость, VK и MAX в один день.
 * Возвращает { granted, added, energy }.
 */
function claimSocialBonusByField(user, field, now = Date.now()) {
  const todayKey = dateKey(now);
  if (user[field] === todayKey) {
    return { granted: false, added: 0, energy: user.energy };
  }
  const ceiling = user.maxEnergy + NEWS_BONUS_CEILING_EXTRA;
  const before = user.energy;
  user.energy = Math.min(ceiling, user.energy + NEWS_BONUS_ENERGY);
  user[field] = todayKey;
  return { granted: true, added: user.energy - before, energy: user.energy };
}

function isSocialBonusFieldAvailable(user, field, now = Date.now()) {
  return user[field] !== dateKey(now);
}

function claimNewsBonus(user, now = Date.now()) {
  return claimSocialBonusByField(user, "lastNewsBonusDate", now);
}
function isNewsBonusAvailable(user, now = Date.now()) {
  return isSocialBonusFieldAvailable(user, "lastNewsBonusDate", now);
}

function claimVkBonus(user, now = Date.now()) {
  return claimSocialBonusByField(user, "lastVkBonusDate", now);
}
function isVkBonusAvailable(user, now = Date.now()) {
  return isSocialBonusFieldAvailable(user, "lastVkBonusDate", now);
}

function claimMaxBonus(user, now = Date.now()) {
  return claimSocialBonusByField(user, "lastMaxBonusDate", now);
}
function isMaxBonusAvailable(user, now = Date.now()) {
  return isSocialBonusFieldAvailable(user, "lastMaxBonusDate", now);
}

/** Активен ли сегодня безлимитный режим (день настоящего матча клуба). */
function isMatchDayActive(settings, now = Date.now()) {
  return Boolean(settings && settings.matchDayKey === dateKey(now));
}

/**
 * Начисляет бонус за успешное приглашение друга. Мутирует ОБА объекта user.
 * У инвайтера — постоянная прибавка к максимуму энергии с потолком
 * REFERRAL_INVITER_MAX_BONUSES (после потолка достижение и счётчик всё равно
 * растут — просто прибавка энергии больше не даётся); у приглашённого —
 * разовая прибавка при первом входе. checkAchievements (вызывается отдельно,
 * при следующей же сериализации инвайтера) сам выдаст значок "Заводила" по
 * referralCount >= 1 — здесь только считаем цифры.
 */
function creditReferral(inviter, invitee, now = Date.now()) {
  invitee.referredBy = inviter.id;
  invitee.maxEnergy += REFERRAL_INVITEE_ENERGY_BONUS;
  invitee.energy = Math.min(invitee.maxEnergy, invitee.energy + REFERRAL_INVITEE_ENERGY_BONUS);

  const bonusesSoFar = inviter.referralCount || 0;
  let inviterBonusApplied = false;
  if (bonusesSoFar < REFERRAL_INVITER_MAX_BONUSES) {
    inviter.maxEnergy += REFERRAL_INVITER_ENERGY_BONUS;
    inviter.energy = Math.min(inviter.maxEnergy, inviter.energy + REFERRAL_INVITER_ENERGY_BONUS);
    inviterBonusApplied = true;
  }
  inviter.referralCount = bonusesSoFar + 1;
  return { inviterBonusApplied, referralCount: inviter.referralCount };
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

/**
 * Ключ "вчерашнего" клубного дня — основа для утренней рассылки/баннера
 * "ты был лидером дня" (см. buildDailyLeaders ниже). В клубной таймзоне нет
 * перехода на летнее время, поэтому вычитание ровно 24 часов безопасно.
 */
function yesterdayKey(now = Date.now()) {
  return dateKey(now - 24 * 60 * 60 * 1000);
}

/**
 * Сбрасывает дневной счёт голов при наступлении нового клубного дня —
 * ровно как ensureCurrentWeek, но дополнительно "замораживает" итог только
 * что закончившегося дня в prevDayGoals/prevDayKey. Эта заморозка происходит
 * один раз, в первый же вызов после полуночи (по времени клуба), и именно она
 * используется потом как "результат вчерашнего дня" — buildDailyLeaders
 * смотрит только на prevDayGoals/prevDayKey, а не на "живой" dayGoals,
 * который к этому моменту уже обнулён для нового дня. Мутирует user.
 */
function ensureCurrentDay(user, now = Date.now()) {
  const curDay = dateKey(now);
  if (user.dayKey !== curDay) {
    user.prevDayKey = user.dayKey || null;
    user.prevDayGoals = user.dayKey ? user.dayGoals || 0 : 0;
    user.dayKey = curDay;
    user.dayGoals = 0;
  }
  return user;
}

/**
 * Топ игроков по голам за ВЧЕРА (по клубному дню) — те самые "лидеры дня",
 * которым на следующий день можно напомнить сыграть ещё (в Telegram — личным
 * сообщением от бота, вне Telegram — баннером в самой игре при следующем
 * заходе). Смотрит на "замороженный" итог прошлого дня (см. ensureCurrentDay),
 * поэтому корректно работает в любой момент нового дня, даже после того как
 * dayGoals уже обнулился на сегодня.
 */
function buildDailyLeaders(users, now = Date.now(), topN = 1) {
  const yKey = yesterdayKey(now);
  return users
    .filter((u) => u.prevDayKey === yKey && (u.prevDayGoals || 0) > 0)
    .sort((a, b) => (b.prevDayGoals || 0) - (a.prevDayGoals || 0))
    .slice(0, topN)
    .map((u) => ({
      id: u.id,
      name: u.firstName || u.username || "Болельщик",
      goals: u.prevDayGoals,
      dayKey: yKey,
    }));
}

// Именные "этажи" сложности поверх уже существующей плавной прогрессии —
// чтобы игроку было наглядно видно "я прошёл Лёгкий, играю на Среднем", а не
// просто безликие цифры уровня. Прогресс между этажами остаётся автоматическим
// (как и раньше — забил идеальный матч, перешёл на уровень выше).
//
// ВАЖНО: раньше прогресс жёстко останавливался на MAX_LEVEL (30) — сильные
// игроки упирались в потолок и сложность переставала расти. Теперь уровень
// растёт БЕСКОНЕЧНО (см. submitMatchResult), а после "Мастера" идут ещё два
// этажа для тех, кто продолжает играть дальше классического списка соперников
// (см. OPPONENTS/getOpponentName — там уже был предусмотрен "круг 2, 3..."
// на этот случай). Сама сложность вратаря (см. getKeeperDifficulty) при этом
// естественно выходит на плато уже около 35-40 уровня — игра не становится
// буквально непроходимой, но дальше практически не может стать ещё сложнее.
const DIFFICULTY_TIERS = [
  { name: "Лёгкий", maxLevel: Math.round(MAX_LEVEL / 3) },
  { name: "Средний", maxLevel: Math.round((MAX_LEVEL / 3) * 2) },
  { name: "Мастер", maxLevel: MAX_LEVEL },
  { name: "Легенда", maxLevel: MAX_LEVEL + OPPONENTS.length }, // второй круг соперников
  { name: "Бессмертный", maxLevel: Infinity }, // дальше предел — только в самом игроке
];

function getDifficultyTierName(level) {
  const lvl = Math.max(1, Math.round(level));
  const tier = DIFFICULTY_TIERS.find((t) => lvl <= t.maxLevel);
  return tier ? tier.name : DIFFICULTY_TIERS[DIFFICULTY_TIERS.length - 1].name;
}

/** Параметры сложности вратаря на заданном уровне. Уровень больше не обрезается
 * сверху — но сама формула (max/min внутри) естественно выходит на плато
 * задолго до заоблачных уровней, так что игра остаётся честной, просто очень сложной. */
function getKeeperDifficulty(level) {
  const lvl = Math.max(1, level);
  // Реакция вратаря (мс на перемещение к точке удара) — чем меньше, тем сложнее.
  const reactionMs = Math.max(220, 620 - lvl * 13);
  // Доля ворот, которую вратарь способен "закрыть" одним броском (0..1).
  const coverage = Math.min(0.85, 0.35 + lvl * 0.016);
  // Случайные финты (вратарь иногда стартует в неверную сторону)
  const feintChance = Math.min(0.35, lvl * 0.01);
  const tier = getDifficultyTierName(lvl);
  return { level: lvl, reactionMs, coverage, feintChance, tier };
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
  const mode = getModeForLevel(user.level);
  const token = `${user.id}.${now}.${Math.random().toString(36).slice(2, 10)}`;
  user.activeMatch = { token, createdAt: now, level: user.level, unlimited, mode };
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
  const mode = match.mode || getModeForLevel(match.level || user.level);

  ensureCurrentWeek(user, now);
  ensureCurrentDay(user, now);
  user.totalGoals += safeGoals;
  user.weekGoals += safeGoals;
  user.dayGoals += safeGoals;
  user.bestScore = Math.max(user.bestScore, safeGoals);

  const perfect = safeGoals === SHOTS_PER_MATCH;
  const prevLevel = user.level;
  // Прогресс больше не упирается в потолок MAX_LEVEL — растёт, пока игрок
  // продолжает выбивать идеальные матчи (см. комментарий у DIFFICULTY_TIERS).
  if (perfect) {
    user.level += 1;
  }
  user.activeMatch = null;

  const newAchievements = checkAchievements(user, { goals: safeGoals, mode, perfect });
  const newTier = getDifficultyTierName(user.level);
  const tierChanged = perfect && newTier !== getDifficultyTierName(prevLevel);

  return {
    goals: safeGoals,
    perfect,
    playedMode: mode,
    newLevel: user.level,
    totalGoals: user.totalGoals,
    weekGoals: user.weekGoals,
    bestScore: user.bestScore,
    newAchievements,
    tierChanged,
    tierName: newTier,
  };
}

// ------------------------- Тренировка (свободный выбор режима) -------------
//
// В обычной игре режим (атака/защита) чередуется по уровню автоматически —
// это остаётся неизменным. Тренировка — отдельная, независимая песочница:
// игрок сам выбирает, что отрабатывать, играет на сложности своего текущего
// уровня, но результат НИКАК не влияет на уровень, энергию, статистику или
// достижения. Поэтому: не тратит энергию, не ограничена по числу попыток,
// не пишется в totalGoals/weekGoals/лидерборд, не выдаёт значки.

function startTrainingMatch(user, mode, now = Date.now()) {
  const normalizedMode = mode === "defense" ? "defense" : "attack";
  const token = `training.${user.id}.${now}.${Math.random().toString(36).slice(2, 10)}`;
  user.activeTraining = { token, createdAt: now, mode: normalizedMode, level: user.level };
  return { token, mode: normalizedMode, difficulty: getKeeperDifficulty(user.level) };
}

function submitTrainingResult(user, token, goals, now = Date.now()) {
  const training = user.activeTraining;
  if (!training || training.token !== token) {
    throw new Error("INVALID_TRAINING_TOKEN");
  }
  if (now - training.createdAt > MATCH_TOKEN_TTL_MS) {
    user.activeTraining = null;
    throw new Error("TRAINING_EXPIRED");
  }
  const safeGoals = Math.max(0, Math.min(SHOTS_PER_MATCH, Math.round(goals)));
  const perfect = safeGoals === SHOTS_PER_MATCH;
  user.activeTraining = null;
  return { goals: safeGoals, perfect, mode: training.mode };
}

// ------------------------- Дуэли (вызов друга по ссылке) -------------------
//
// Асинхронный формат: один игрок создаёт дуэль и играет свою попытку, когда
// удобно; ссылку отправляет другу, тот играет свою попытку отдельно, когда
// удобно ему. Как только оба сыграли — оба узнают результат. Сложность
// фиксированная и одинаковая для обоих — чтобы было честно, независимо от
// того, кто на каком уровне в основной кампании.

const DUEL_SHOTS = 20;
const DUEL_DIFFICULTY_LEVEL = 15; // фиксированный уровень сложности ("Средний") для обоих игроков

function getDuelDifficulty() {
  return getKeeperDifficulty(DUEL_DIFFICULTY_LEVEL);
}

function createDuel(creatorId, creatorName, now = Date.now()) {
  const id = `${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  return {
    id,
    creatorId: String(creatorId),
    creatorName: creatorName || "Игрок",
    opponentId: null,
    opponentName: null,
    shotsPerDuel: DUEL_SHOTS,
    creatorGoals: null,
    opponentGoals: null,
    creatorToken: null,
    opponentToken: null,
    notified: false,
    createdAt: now,
  };
}

/** Кем приходится userId этой дуэли: 'creator' | 'opponent' | 'opponent-candidate' (место ещё свободно) | 'spectator'. */
function roleForUser(duel, userId) {
  const uid = String(userId);
  if (uid === duel.creatorId) return "creator";
  if (duel.opponentId && uid === duel.opponentId) return "opponent";
  if (!duel.opponentId) return "opponent-candidate";
  return "spectator";
}

/** Выдаёт токен на попытку в дуэли. Мутирует duel (может занять место "opponent"). */
function startDuelAttempt(duel, userId, userName, now = Date.now()) {
  const role = roleForUser(duel, userId);
  if (role === "spectator") {
    throw new Error("DUEL_FULL");
  }
  if (role === "creator" && duel.creatorGoals != null) {
    throw new Error("ALREADY_PLAYED");
  }
  if ((role === "opponent" || role === "opponent-candidate") && duel.opponentGoals != null) {
    throw new Error("ALREADY_PLAYED");
  }
  if (role === "opponent-candidate") {
    duel.opponentId = String(userId);
    duel.opponentName = userName || "Соперник";
  }
  const finalRole = role === "opponent-candidate" ? "opponent" : role;
  const token = `${duel.id}.${finalRole}.${now}.${Math.random().toString(36).slice(2, 8)}`;
  if (finalRole === "creator") {
    duel.creatorToken = token;
  } else {
    duel.opponentToken = token;
  }
  return { token, role: finalRole };
}

/**
 * Принимает результат попытки в дуэли. Мутирует duel.
 * Возвращает { role, finished, winner } — winner: 'creator' | 'opponent' | 'draw' | null (пока не оба сыграли).
 */
function submitDuelResult(duel, userId, token, goals, now = Date.now()) {
  const role = roleForUser(duel, userId);
  if (role !== "creator" && role !== "opponent") {
    throw new Error("NOT_IN_DUEL");
  }
  const expectedToken = role === "creator" ? duel.creatorToken : duel.opponentToken;
  if (!expectedToken || expectedToken !== token) {
    throw new Error("INVALID_DUEL_TOKEN");
  }
  const safeGoals = Math.max(0, Math.min(duel.shotsPerDuel, Math.round(goals)));
  if (role === "creator") {
    duel.creatorGoals = safeGoals;
  } else {
    duel.opponentGoals = safeGoals;
  }
  const finished = duel.creatorGoals != null && duel.opponentGoals != null;
  let winner = null;
  if (finished) {
    if (duel.creatorGoals > duel.opponentGoals) winner = "creator";
    else if (duel.opponentGoals > duel.creatorGoals) winner = "opponent";
    else winner = "draw";
  }
  return { role, finished, winner };
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
    .map((u) => ({
      id: u.id,
      name: u.firstName || u.username || "Болельщик",
      score: u.weekGoals,
      photoUrl: u.photoUrl || null,
      isReferrer: (u.referralCount || 0) > 0, // маленькая пометка у имени — "приводит друзей"
    }));

  const byAllTime = [...withCurrentWeek]
    .sort((a, b) => b.totalGoals - a.totalGoals)
    .slice(0, limit)
    .map((u) => ({
      id: u.id,
      name: u.firstName || u.username || "Болельщик",
      score: u.totalGoals,
      photoUrl: u.photoUrl || null,
      isReferrer: (u.referralCount || 0) > 0,
    }));

  return { week: byWeek, allTime: byAllTime, weekKey: curWeek };
}

/**
 * "Дорожка" соперников вокруг текущего уровня игрока — немного пройденных
 * (для ощущения прогресса) + текущий + немного предстоящих. Используется для
 * визуальной "карты соперников" на клиенте вместо сухого "следующий соперник: X".
 */
function buildOpponentRoad(level, behind = 2, ahead = 4) {
  const lvl = Math.max(1, Math.round(level));
  const from = Math.max(1, lvl - behind);
  const to = lvl + ahead; // уровень больше не ограничен сверху MAX_LEVEL
  const road = [];
  for (let l = from; l <= to; l++) {
    road.push({
      level: l,
      name: getOpponentName(l),
      status: l < lvl ? "done" : l === lvl ? "current" : "upcoming",
    });
  }
  return road;
}

// ------------------------- Зал славы клуба ----------------------------------
//
// В отличие от лидерборда (который каждую неделю обнуляется), зал славы —
// это абсолютные рекорды за всё время. topN игроков в каждой из трёх
// категорий: лучший результат за один матч, самый длинный стрик подряд
// (bestStreak — см. registerDailyLogin, он не сбрасывается вместе с текущим
// streak) и общее число голов за всё время.
function buildHallOfFame(users, topN = 3) {
  const toRow = (u, value) => ({
    id: u.id,
    name: u.firstName || u.username || "Болельщик",
    value,
    photoUrl: u.photoUrl || null,
  });

  const bestMatch = [...users]
    .filter((u) => (u.bestScore || 0) > 0)
    .sort((a, b) => (b.bestScore || 0) - (a.bestScore || 0))
    .slice(0, topN)
    .map((u) => toRow(u, u.bestScore));

  const longestStreak = [...users]
    .filter((u) => (u.bestStreak || 0) > 0)
    .sort((a, b) => (b.bestStreak || 0) - (a.bestStreak || 0))
    .slice(0, topN)
    .map((u) => toRow(u, u.bestStreak));

  const totalGoals = [...users]
    .filter((u) => (u.totalGoals || 0) > 0)
    .sort((a, b) => (b.totalGoals || 0) - (a.totalGoals || 0))
    .slice(0, topN)
    .map((u) => toRow(u, u.totalGoals));

  // user.level никогда не уменьшается (см. submitMatchResult) — сам по себе
  // уже является "рекордным" показателем, отдельное поле не нужно.
  const topLevel = [...users]
    .filter((u) => (u.level || 1) > 1)
    .sort((a, b) => (b.level || 1) - (a.level || 1))
    .slice(0, topN)
    .map((u) => toRow(u, u.level));

  return { bestMatch, longestStreak, totalGoals, topLevel };
}

// ------------------------- Конкурс дня (с реальным призом) ------------------
//
// Отдельный от "дня матча" (/matchday) режим: тоже даёт безлимитные попытки,
// но привязан не к календарному дню, а к точному моменту запуска (см.
// CONTEST_DURATION_MS выше) и ведёт отдельный подсчёт голов именно за это
// окно — специально для того, чтобы честно определить победителя разового
// конкурса с призом, независимо от остальной игровой статистики.

/** Активен ли сейчас конкурс дня. settings.contestStartTs — ts начала или null. */
function isContestActive(settings, now = Date.now()) {
  if (!settings || !settings.contestStartTs) return false;
  return now < settings.contestStartTs + CONTEST_DURATION_MS;
}

/**
 * Учитывает забитые голы в счёт ТЕКУЩЕГО конкурса (если он сейчас активен).
 * Мутирует user. Не часть submitMatchResult специально — конкурс зависит от
 * глобальных settings, а не только от матча, поэтому вызывается отдельно из
 * server.js после submitMatchResult (см. /api/match/result).
 * contestGoalsForStartTs — метка, каким именно запуском конкурса считаны
 * голы: если стартовал новый конкурс, счёт для этого игрока начинается с
 * нуля, даже если в базе остался "contestGoals" от предыдущего разыгранного
 * конкурса.
 */
function recordContestGoal(user, settings, goals, now = Date.now()) {
  if (!isContestActive(settings, now) || !goals) return user;
  if (user.contestGoalsForStartTs !== settings.contestStartTs) {
    user.contestGoalsForStartTs = settings.contestStartTs;
    user.contestGoals = 0;
  }
  user.contestGoals += goals;
  user.contestGoalsReachedAt = now; // для тай-брейка "кто раньше набрал этот счёт"
  return user;
}

/**
 * Итоги конкретного запуска конкурса (contestStartTs — его "id") — полный
 * список участников, отсортированный по голам, при равенстве выигрывает тот,
 * кто набрал этот результат раньше по времени. Участвуют все — и Telegram,
 * и веб-гости (см. isWebGuestId ниже, используется только для пометки в
 * итоговом сообщении, не для фильтрации).
 */
function buildContestResults(users, contestStartTs) {
  return users
    .filter((u) => u.contestGoalsForStartTs === contestStartTs && (u.contestGoals || 0) > 0)
    .sort((a, b) => {
      if (b.contestGoals !== a.contestGoals) return b.contestGoals - a.contestGoals;
      return (a.contestGoalsReachedAt || 0) - (b.contestGoalsReachedAt || 0);
    })
    .map((u) => ({
      id: u.id,
      name: u.firstName || u.username || "Болельщик",
      goals: u.contestGoals,
      reachedAt: u.contestGoalsReachedAt,
      isTelegram: !isWebGuestId(u.id),
    }));
}

// ------------------------- Приватная статистика (только для админа) --------
//
// Гостевые веб-идентификаторы (см. server.js authOrFail) всегда начинаются с
// "web_" — по этому признаку отличаем "пришёл через Telegram" от "зашёл по
// обычной ссылке" в статистике ниже.
function isWebGuestId(id) {
  return typeof id === "string" && id.startsWith("web_");
}

/**
 * Сводная статистика по игрокам и дуэлям — для приватной команды /stats
 * (доступна только администратору, см. ADMIN_TELEGRAM_ID в server.js).
 * Никак не связана с публичным лидербордом — просто цифры для владельца бота.
 */
function buildStats(users, duels = [], now = Date.now()) {
  const todayKey = dateKey(now);
  const curWeek = weekKey(now);

  let newToday = 0;
  let playedToday = 0;
  let playedThisWeek = 0;
  let fromTelegram = 0;
  let fromWeb = 0;
  let totalGoalsAllTime = 0;

  for (const u of users) {
    if (u.createdAt && dateKey(u.createdAt) === todayKey) newToday++;
    if (u.lastPlayedDate === todayKey) playedToday++;
    if (u.lastPlayedDate) {
      const lastPlayedWeek = weekKey(Date.parse(`${u.lastPlayedDate}T00:00:00Z`));
      if (lastPlayedWeek === curWeek) playedThisWeek++;
    }
    if (isWebGuestId(u.id)) fromWeb++;
    else fromTelegram++;
    totalGoalsAllTime += u.totalGoals || 0;
  }

  const finishedDuels = duels.filter((d) => d.creatorGoals != null && d.opponentGoals != null).length;

  const topActive = [...users]
    .sort((a, b) => (b.totalGoals || 0) - (a.totalGoals || 0))
    .slice(0, 5)
    .map((u) => ({ name: u.firstName || u.username || "Болельщик", totalGoals: u.totalGoals || 0 }));

  return {
    totalPlayers: users.length,
    newToday,
    playedToday,
    playedThisWeek,
    fromTelegram,
    fromWeb,
    totalGoalsAllTime,
    totalDuels: duels.length,
    finishedDuels,
    topActive,
  };
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
  REFERRAL_INVITER_ENERGY_BONUS,
  REFERRAL_INVITER_MAX_BONUSES,
  REFERRAL_INVITEE_ENERGY_BONUS,
  CONTEST_DURATION_MS,
  OPPONENTS,
  ACHIEVEMENTS,
  DIFFICULTY_TIERS,
  DUEL_SHOTS,
  DUEL_DIFFICULTY_LEVEL,
  dateKey,
  weekKey,
  parseClubDateTime,
  formatClubDateTime,
  applyEnergyRegen,
  msUntilNextEnergy,
  registerDailyLogin,
  claimNewsBonus,
  isNewsBonusAvailable,
  claimVkBonus,
  isVkBonusAvailable,
  claimMaxBonus,
  isMaxBonusAvailable,
  isMatchDayActive,
  ensureCurrentWeek,
  ensureCurrentDay,
  yesterdayKey,
  buildDailyLeaders,
  creditReferral,
  buildHallOfFame,
  isContestActive,
  recordContestGoal,
  buildContestResults,
  getKeeperDifficulty,
  getDifficultyTierName,
  getOpponentName,
  getModeForLevel,
  checkAchievements,
  canStartMatch,
  startMatch,
  submitMatchResult,
  startTrainingMatch,
  submitTrainingResult,
  getDuelDifficulty,
  createDuel,
  roleForUser,
  startDuelAttempt,
  submitDuelResult,
  buildLeaderboard,
  buildOpponentRoad,
  isWebGuestId,
  buildStats,
};
