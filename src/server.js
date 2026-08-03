require("dotenv").config();
const path = require("path");
const express = require("express");
const { Bot, webhookCallback, InlineKeyboard } = require("grammy");

const db = require("./db");
const logic = require("./game-logic");
const { verifyInitDataOrDev } = require("./telegram-auth");

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN;
const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/+$/, ""); // без завершающего "/"
const CLUB_NAME = process.env.CLUB_NAME || 'ХК «Знамя-Удмуртия»';
const NEWS_URL = process.env.NEWS_URL || ""; // куда вести за бонусной попыткой (канал/сайт клуба)
const VK_URL = process.env.VK_URL || ""; // ссылка на сообщество клуба ВКонтакте (для бонуса за подписку)
const MAX_URL = process.env.MAX_URL || ""; // ссылка на канал клуба в MAX (для бонуса за подписку)
// Telegram-ID администратора(ов), которым можно включать безлимит в дни матчей.
// Через запятую, если их несколько. Свой ID можно узнать командой /myid у бота.
const ADMIN_IDS = (process.env.ADMIN_TELEGRAM_ID || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Сколько игроков считаются "лидерами дня" и получают на следующий день
// напоминание сыграть ещё (личным сообщением в Telegram или баннером в игре
// для тех, кто зашёл не из Telegram). См. notifyDailyLeadersIfDue() ниже.
const DAILY_LEADER_TOP_N = 1;
// Час по времени клуба (UTC+4), после которого можно слать утреннюю рассылку —
// чтобы не будить лидера дня посреди ночи.
const DAILY_LEADER_NOTIFY_HOUR = 9;

// Сколько игроков показывать в каждой из трёх категорий зала славы.
const HALL_OF_FAME_TOP_N = 3;
// День недели (0=воскресенье..6=суббота, как у Date.getUTCDay) и час по
// времени клуба, когда уходит еженедельная рассылка залаславы.
const HALL_OF_FAME_NOTIFY_WEEKDAY = 1; // понедельник
const HALL_OF_FAME_NOTIFY_HOUR = 10;

if (!BOT_TOKEN) {
  console.warn(
    "[WARN] BOT_TOKEN не задан. Сайт мини-аппа и API поднимутся, но бот работать не будет.\n" +
      "Смотри .env.example и инструкцию BOTFATHER.md."
  );
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

// Формат клиентского веб-идентификатора для гостевого входа (см. ниже).
const WEB_GUEST_ID_RE = /^web_[a-z0-9]{6,40}$/;

function authOrFail(req, res) {
  const initData = req.body?.initData || req.query?.initData;
  if (initData) {
    const check = verifyInitDataOrDev(initData, BOT_TOKEN);
    if (!check.ok) {
      res.status(401).json({ error: "AUTH_FAILED", reason: check.reason });
      return null;
    }
    return check.user;
  }

  // Гостевой веб-вход: для тех, кто открыл игру просто по ссылке, а не через
  // Telegram (например, из поста ВКонтакте) — без Telegram нет способа
  // криптографически проверить личность, поэтому доверяем клиенту случайный
  // идентификатор, который он сам сгенерировал и хранит у себя в браузере.
  // Это осознанный компромисс ради охвата аудитории без Telegram/VPN — см.
  // раздел "Честные ограничения" в README.
  const webId = req.body?.webId || req.query?.webId;
  if (typeof webId === "string" && WEB_GUEST_ID_RE.test(webId)) {
    const rawName = req.body?.webName || req.query?.webName;
    const safeName = (typeof rawName === "string" ? rawName : "").replace(/[\r\n\t]/g, " ").trim().slice(0, 24) || "Болельщик";
    return { id: webId, first_name: safeName, username: null };
  }

  res.status(401).json({ error: "AUTH_FAILED", reason: "NO_AUTH" });
  return null;
}

function serializeUser(user, now) {
  logic.applyEnergyRegen(user, now);
  logic.ensureCurrentWeek(user, now);
  logic.ensureCurrentDay(user, now);
  const settings = db.getSettings();
  const matchDayActive = logic.isMatchDayActive(settings, now);
  return {
    id: user.id,
    energy: user.energy,
    maxEnergy: user.maxEnergy,
    msUntilNextEnergy: logic.msUntilNextEnergy(user, now),
    streak: user.streak,
    level: user.level,
    bestScore: user.bestScore,
    totalGoals: user.totalGoals,
    weekGoals: user.weekGoals,
    shotsPerMatch: logic.SHOTS_PER_MATCH,
    difficulty: logic.getKeeperDifficulty(user.level),
    opponentName: logic.getOpponentName(user.level),
    mode: logic.getModeForLevel(user.level),
    achievements: user.achievements || [],
    opponentRoad: logic.buildOpponentRoad(user.level),
    club: CLUB_NAME,
    matchDayActive,
    contestActive: logic.isContestActive(settings, now),
    newsBonusAvailable: Boolean(NEWS_URL) && logic.isNewsBonusAvailable(user, now),
    newsUrl: NEWS_URL || null,
    vkBonusAvailable: Boolean(VK_URL) && logic.isVkBonusAvailable(user, now),
    vkUrl: VK_URL || null,
    maxBonusAvailable: Boolean(MAX_URL) && logic.isMaxBonusAvailable(user, now),
    maxUrl: MAX_URL || null,
    botUrl: botUsername ? `https://t.me/${botUsername}` : null,
    referralCount: user.referralCount || 0,
  };
}

// --- API ---------------------------------------------------------------

app.post("/api/auth", (req, res) => {
  const tgUser = authOrFail(req, res);
  if (!tgUser) return;
  const now = Date.now();

  const isNewUser = !db.getUser(tgUser.id);
  const user = db.getOrCreateUser(tgUser.id, {
    username: tgUser.username,
    firstName: tgUser.first_name,
    photoUrl: tgUser.photo_url,
  });

  logic.applyEnergyRegen(user, now);
  logic.ensureCurrentDay(user, now);
  const loginResult = logic.registerDailyLogin(user, now);
  logic.ensureCurrentWeek(user, now);

  // Реферальная механика — засчитываем только по-настоящему новым игрокам
  // (иначе можно было бы получать бонус повторно, просто переоткрывая
  // ссылку). ref приходит либо из t.me-диплинка (?start=ref_<id>, бот кладёт
  // его в URL мини-аппа), либо прямо из обычной веб-ссылки ?ref=<id>.
  let referralApplied = false;
  if (isNewUser) {
    const refCode = req.body?.ref || req.query?.ref;
    if (typeof refCode === "string" && refCode && refCode !== user.id) {
      const inviter = db.getUser(refCode);
      if (inviter) {
        logic.creditReferral(inviter, user, now);
        logic.checkAchievements(inviter, {}); // чтобы "Заводила" появился у инвайтера сразу, не дожидаясь его следующего матча
        db.saveUser(inviter);
        referralApplied = true;
      }
    }
  }

  const newAchievements = logic.checkAchievements(user, {});

  // "Ты был лидером дня" — баннер в самой игре для тех, кто зашёл не из
  // Telegram (им нельзя отправить личное сообщение — см. isWebGuestId).
  // Telegram-игрокам это не нужно: они и так получают личное сообщение от
  // бота (см. notifyDailyLeadersIfDue ниже) — показывать им баннер ещё раз
  // было бы избыточно. Показывается ровно один раз благодаря
  // leaderBannerShownForDay (тот же приём, что и у бонусов за подписки).
  let leaderBanner = null;
  const yKey = logic.yesterdayKey(now);
  if (
    logic.isWebGuestId(user.id) &&
    user.leaderBannerShownForDay !== yKey &&
    user.prevDayKey === yKey &&
    (user.prevDayGoals || 0) > 0
  ) {
    const leaders = logic.buildDailyLeaders(db.getAllUsers(), now, DAILY_LEADER_TOP_N);
    if (leaders.some((l) => l.id === user.id)) {
      leaderBanner = { goals: user.prevDayGoals };
      user.leaderBannerShownForDay = yKey;
    }
  }

  // Зал славы — тот же приём: раз в неделю показываем веб-гостю баннер с
  // текущими тремя категориями (у Telegram-игроков — своя еженедельная
  // рассылка от бота, см. notifyHallOfFameIfDue ниже).
  let hallOfFameBanner = null;
  const curWeek = logic.weekKey(now);
  if (logic.isWebGuestId(user.id) && user.hallOfFameBannerShownForWeek !== curWeek) {
    hallOfFameBanner = logic.buildHallOfFame(db.getAllUsers(), HALL_OF_FAME_TOP_N);
    user.hallOfFameBannerShownForWeek = curWeek;
  }

  db.saveUser(user);

  res.json({
    ...serializeUser(user, now),
    dailyBonus: loginResult,
    newAchievements,
    achievementCatalog: logic.ACHIEVEMENTS,
    leaderBanner,
    hallOfFameBanner,
    referralApplied,
  });
});

app.get("/api/leaderboard", (req, res) => {
  const now = Date.now();
  const users = db.getAllUsers();
  res.json(logic.buildLeaderboard(users, now));
});

app.get("/api/hall-of-fame", (_req, res) => {
  const users = db.getAllUsers();
  res.json(logic.buildHallOfFame(users, HALL_OF_FAME_TOP_N));
});

app.post("/api/match/start", (req, res) => {
  const tgUser = authOrFail(req, res);
  if (!tgUser) return;
  const now = Date.now();
  const user = db.getOrCreateUser(tgUser.id, {});
  logic.applyEnergyRegen(user, now);
  const settings = db.getSettings();
  // День настоящего матча клуба (/matchday) и конкурс дня (/contest) — два
  // независимых переключателя, но оба дают безлимитные попытки одинаково.
  const unlimited = logic.isMatchDayActive(settings, now) || logic.isContestActive(settings, now);

  if (!logic.canStartMatch(user, unlimited)) {
    db.saveUser(user);
    return res.status(409).json({
      error: "NO_ENERGY",
      msUntilNextEnergy: logic.msUntilNextEnergy(user, now),
    });
  }

  const token = logic.startMatch(user, now, unlimited);
  db.saveUser(user);
  res.json({
    token,
    shotsPerMatch: logic.SHOTS_PER_MATCH,
    difficulty: logic.getKeeperDifficulty(user.level),
    energy: user.energy,
    unlimited,
    mode: user.activeMatch.mode,
    opponentName: logic.getOpponentName(user.level),
  });
});

// Общий обработчик для бонусов "перейди по ссылке клуба" (новость/VK/MAX) —
// сама механика одна и та же, отличается только ссылка и функция из game-logic.
function makeBonusRoute(urlValue, claimFn) {
  return (req, res) => {
    const tgUser = authOrFail(req, res);
    if (!tgUser) return;
    if (!urlValue) {
      return res.status(400).json({ error: "BONUS_NOT_CONFIGURED" });
    }
    const now = Date.now();
    const user = db.getOrCreateUser(tgUser.id, {});
    logic.applyEnergyRegen(user, now);
    const bonus = claimFn(user, now);
    db.saveUser(user);
    res.json({ ...bonus, ...serializeUser(user, now) });
  };
}

app.post("/api/bonus/news", makeBonusRoute(NEWS_URL, logic.claimNewsBonus));
app.post("/api/bonus/vk", makeBonusRoute(VK_URL, logic.claimVkBonus));
app.post("/api/bonus/max", makeBonusRoute(MAX_URL, logic.claimMaxBonus));

app.post("/api/match/result", (req, res) => {
  const tgUser = authOrFail(req, res);
  if (!tgUser) return;
  const { token, goals } = req.body || {};
  const now = Date.now();
  const user = db.getOrCreateUser(tgUser.id, {});

  try {
    const result = logic.submitMatchResult(user, token, Number(goals), now);
    // Учитываем гол(ы) в счёт конкурса дня, если он сейчас идёт — отдельно от
    // submitMatchResult, потому что зависит от глобальных settings, а не
    // только от самого матча (см. recordContestGoal в game-logic.js).
    logic.recordContestGoal(user, db.getSettings(), result.goals, now);
    db.saveUser(user);
    res.json({ ...result, ...serializeUser(user, now) });
  } catch (err) {
    db.saveUser(user);
    res.status(400).json({ error: err.message });
  }
});

// --- Тренировка (свободный выбор атаки/защиты, без влияния на прогресс) ----

app.post("/api/training/start", (req, res) => {
  const tgUser = authOrFail(req, res);
  if (!tgUser) return;
  const { mode } = req.body || {};
  const user = db.getOrCreateUser(tgUser.id, {});
  const result = logic.startTrainingMatch(user, mode);
  db.saveUser(user);
  res.json({ ...result, shotsPerMatch: logic.SHOTS_PER_MATCH });
});

app.post("/api/training/result", (req, res) => {
  const tgUser = authOrFail(req, res);
  if (!tgUser) return;
  const { token, goals } = req.body || {};
  const user = db.getOrCreateUser(tgUser.id, {});
  try {
    const result = logic.submitTrainingResult(user, token, Number(goals));
    db.saveUser(user);
    res.json(result);
  } catch (err) {
    db.saveUser(user);
    res.status(400).json({ error: err.message });
  }
});

// --- Дуэли (вызов друга по ссылке) --------------------------------------

app.post("/api/duel/create", (req, res) => {
  const tgUser = authOrFail(req, res);
  if (!tgUser) return;
  const now = Date.now();
  const name = tgUser.first_name || tgUser.username || "Игрок";
  const duel = logic.createDuel(tgUser.id, name, now);
  db.saveDuel(duel);
  const shareUrl = botUsername ? `https://t.me/${botUsername}?start=duel_${duel.id}` : null;
  // Обычная веб-ссылка на дуэль — работает для кого угодно (не только для
  // Telegram-бота), в том числе для гостей, зашедших просто по ссылке из VK.
  const webUrl = PUBLIC_URL ? `${PUBLIC_URL}/?duel=${duel.id}` : null;
  res.json({
    duelId: duel.id,
    shareUrl,
    webUrl,
    shotsPerDuel: duel.shotsPerDuel,
    difficulty: logic.getDuelDifficulty(),
  });
});

app.post("/api/duel/info", (req, res) => {
  const tgUser = authOrFail(req, res);
  if (!tgUser) return;
  const { duelId } = req.body || {};
  const duel = db.getDuel(duelId);
  if (!duel) {
    return res.status(404).json({ error: "DUEL_NOT_FOUND" });
  }
  const role = logic.roleForUser(duel, tgUser.id);
  const finished = duel.creatorGoals != null && duel.opponentGoals != null;
  const alreadyPlayed =
    role === "creator" ? duel.creatorGoals != null : role === "opponent" ? duel.opponentGoals != null : false;
  res.json({
    duelId: duel.id,
    creatorName: duel.creatorName,
    opponentName: duel.opponentName,
    shotsPerDuel: duel.shotsPerDuel,
    difficulty: logic.getDuelDifficulty(),
    role,
    finished,
    alreadyPlayed,
    creatorGoals: finished ? duel.creatorGoals : null,
    opponentGoals: finished ? duel.opponentGoals : null,
  });
});

app.post("/api/duel/start", (req, res) => {
  const tgUser = authOrFail(req, res);
  if (!tgUser) return;
  const { duelId } = req.body || {};
  const duel = db.getDuel(duelId);
  if (!duel) {
    return res.status(404).json({ error: "DUEL_NOT_FOUND" });
  }
  const name = tgUser.first_name || tgUser.username || "Соперник";
  try {
    const { token, role } = logic.startDuelAttempt(duel, tgUser.id, name);
    db.saveDuel(duel);
    res.json({ token, role, shotsPerDuel: duel.shotsPerDuel, difficulty: logic.getDuelDifficulty() });
  } catch (err) {
    res.status(409).json({ error: err.message });
  }
});

app.post("/api/duel/result", async (req, res) => {
  const tgUser = authOrFail(req, res);
  if (!tgUser) return;
  const { duelId, token, goals } = req.body || {};
  const duel = db.getDuel(duelId);
  if (!duel) {
    return res.status(404).json({ error: "DUEL_NOT_FOUND" });
  }
  let outcome;
  try {
    outcome = logic.submitDuelResult(duel, tgUser.id, token, Number(goals), Date.now());
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  db.saveDuel(duel);

  if (outcome.finished && !duel.notified && bot) {
    duel.notified = true;
    db.saveDuel(duel);
    const summary =
      outcome.winner === "draw"
        ? `Ничья! ${duel.creatorName} — ${duel.creatorGoals}, ${duel.opponentName} — ${duel.opponentGoals}.`
        : `Победитель — ${outcome.winner === "creator" ? duel.creatorName : duel.opponentName}! ` +
          `${duel.creatorName} — ${duel.creatorGoals}, ${duel.opponentName} — ${duel.opponentGoals}.`;
    const text = `⚔️ Дуэль завершена!\n${summary}`;
    try {
      await bot.api.sendMessage(duel.creatorId, text);
    } catch (_) {
      /* пользователь мог не начинать чат с ботом — ничего страшного */
    }
    if (duel.opponentId) {
      try {
        await bot.api.sendMessage(duel.opponentId, text);
      } catch (_) {}
    }
  }

  res.json({
    ...outcome,
    creatorName: duel.creatorName,
    opponentName: duel.opponentName,
    creatorGoals: duel.creatorGoals,
    opponentGoals: duel.opponentGoals,
  });
});

app.get("/healthz", (_req, res) => res.json({ ok: true }));

// --- Telegram-бот --------------------------------------------------------

let bot = null;
let botUsername = null; // подтягивается при старте — нужен для ссылок-приглашений на дуэль

if (BOT_TOKEN) {
  bot = new Bot(BOT_TOKEN);

  bot.command("start", async (ctx) => {
    if (!PUBLIC_URL) {
      await ctx.reply(
        "Игра почти готова! Администратору нужно задать PUBLIC_URL в настройках сервера, чтобы кнопка заработала."
      );
      return;
    }

    // Диплинк-приглашение на дуэль: t.me/<bot>?start=duel_<id>
    const payload = (ctx.match || "").trim();
    if (payload.startsWith("duel_")) {
      const duelId = payload.slice("duel_".length);
      const duel = db.getDuel(duelId);
      if (!duel) {
        await ctx.reply("Эта дуэль не найдена — возможно, ссылка устарела. Попроси прислать новую.");
        return;
      }
      const duelKeyboard = new InlineKeyboard().webApp("⚔️ Принять вызов", `${PUBLIC_URL}/?duel=${duelId}`);
      await ctx.reply(
        `${duel.creatorName} вызывает тебя на дуэль в «Забей гол»! ⚔️\n\n` +
          `${duel.shotsPerDuel} ударов, у обоих одинаковый вратарь — честная игра. Го?`,
        { reply_markup: duelKeyboard }
      );
      return;
    }

    // Реферальная диплинк-приглашение: t.me/<bot>?start=ref_<id>. Само
    // начисление бонуса происходит позже, в /api/auth (когда мини-апп
    // реально откроется и авторизуется) — здесь только прокидываем ref в URL
    // мини-аппа, ровно как и с дуэлью выше.
    if (payload.startsWith("ref_")) {
      const refId = payload.slice("ref_".length);
      const keyboard = new InlineKeyboard().webApp("⚽ Забить гол", `${PUBLIC_URL}/?ref=${encodeURIComponent(refId)}`);
      await ctx.reply(
        `Тебя пригласили сыграть в «Забей гол» — ${CLUB_NAME}! ⚪🔴\n\n` +
          `Заходи по кнопке ниже — и ты, и тот, кто позвал, получите бонус к максимуму энергии.`,
        { reply_markup: keyboard }
      );
      return;
    }

    const keyboard = new InlineKeyboard().webApp("⚽ Забить гол", `${PUBLIC_URL}/`);
    await ctx.reply(
      `${CLUB_NAME} приглашает сыграть! ⚪🔴\n\n` +
        `Проходи по очереди настоящих соперников лиги — где-то забивай голы вратарю ⚽, ` +
        `а где-то сам встань в ворота и отражай броски 🧤. Копи очки, держи стрик и открывай значки.\n` +
        `Энергия восстанавливается сама — заходи почаще! А ещё можно вызвать друга на дуэль прямо из игры.`,
      { reply_markup: keyboard }
    );
  });

  bot.command("myid", async (ctx) => {
    await ctx.reply(
      `Твой Telegram ID: ${ctx.from.id}\n\n` +
        `Чтобы получить право включать безлимит в дни матчей, впиши это число ` +
        `в переменную окружения ADMIN_TELEGRAM_ID на хостинге и перезапусти сервис.`
    );
  });

  bot.command("matchday", async (ctx) => {
    const fromId = String(ctx.from.id);
    if (ADMIN_IDS.length === 0) {
      await ctx.reply(
        "ADMIN_TELEGRAM_ID ещё не настроен на сервере — команда пока недоступна никому. " +
          "Узнай свой ID командой /myid и попроси администратора хостинга вписать его в настройки."
      );
      return;
    }
    if (!ADMIN_IDS.includes(fromId)) {
      await ctx.reply("Эта команда только для администратора клуба.");
      return;
    }
    const settings = db.getSettings();
    const now = Date.now();
    if (logic.isMatchDayActive(settings, now)) {
      db.setMatchDay(null);
      await ctx.reply("Безлимитный режим выключен. Энергия снова ограничена как обычно.");
    } else {
      db.setMatchDay(logic.dateKey(now));
      await ctx.reply(
        "🔴⚪ Безлимитный режим включён на сегодня — у всех болельщиков неограниченные попытки! " +
          "Отправь эту же команду ещё раз, чтобы выключить раньше времени."
      );
    }
  });

  // Конкурс дня с реальным призом — отдельная команда от /matchday: тоже
  // даёт безлимит, но привязан к точному моменту запуска (ровно 24 часа),
  // а не к календарному дню, и ведёт отдельный подсчёт голов именно за это
  // окно (см. CONTEST_DURATION_MS/recordContestGoal в game-logic.js).
  //
  // /contest [текст приза] — запустить (или, если уже идёт, остановить)
  //   конкурс ПРЯМО СЕЙЧАС. Всё, что написано после команды, попадёт в
  //   анонс всем игрокам как описание приза, например:
  //   /contest Три браслета с символикой клуба
  bot.command("contest", async (ctx) => {
    const fromId = String(ctx.from.id);
    if (ADMIN_IDS.length === 0) {
      await ctx.reply(
        "ADMIN_TELEGRAM_ID ещё не настроен на сервере — команда пока недоступна никому. " +
          "Узнай свой ID командой /myid и попроси администратора хостинга вписать его в настройки."
      );
      return;
    }
    if (!ADMIN_IDS.includes(fromId)) {
      await ctx.reply("Эта команда только для администратора клуба.");
      return;
    }
    const settings = db.getSettings();
    const now = Date.now();
    if (logic.isContestActive(settings, now)) {
      const startTs = settings.contestStartTs;
      await finalizeContestNow(startTs, "остановлен вручную досрочно");
      await ctx.reply("Конкурс дня остановлен досрочно. Итоги — сообщением выше.");
      return;
    }
    if (settings.contestScheduledStart) {
      db.setContestSchedule(null, null); // ручной запуск отменяет запланированный автостарт
    }
    const prizeText = (ctx.match || "").trim();
    const hours = Math.round(logic.CONTEST_DURATION_MS / 3600000);
    await startContestNow(now, prizeText);
    await ctx.reply(
      `🏆 Конкурс дня запущен! На ближайшие ${hours} часов у ВСЕХ игроков — и из Telegram, и по обычной ссылке (ВК/браузер) — ` +
        `безлимитные попытки. Всем игрокам-подписчикам бота уже отправлено уведомление о старте. ` +
        `Через ${hours} часов бот сам пришлёт тебе итоги с победителем. ` +
        `Чтобы остановить раньше срока и получить итоги прямо сейчас — отправь /contest ещё раз.`
    );
  });

  // /contest_at 2026-08-03 08:00 [текст приза] — запланировать автостарт
  //   конкурса на конкретный момент (время указывается по времени клуба —
  //   Ижевск/Самара, UTC+4). В нужный момент бот сам включит безлимит и
  //   разошлёт анонс всем игрокам, без участия администратора.
  //   ВАЖНО: бесплатный хостинг проверяет расписание раз в ~10 минут (см.
  //   README), поэтому фактический старт может сдвинуться на несколько
  //   минут позже указанного времени. Если нужна точность до секунды —
  //   лучше в этот момент отправить /contest вручную.
  bot.command("contest_at", async (ctx) => {
    const fromId = String(ctx.from.id);
    if (ADMIN_IDS.length === 0) {
      await ctx.reply(
        "ADMIN_TELEGRAM_ID ещё не настроен на сервере — команда пока недоступна никому. " +
          "Узнай свой ID командой /myid и попроси администратора хостинга вписать его в настройки."
      );
      return;
    }
    if (!ADMIN_IDS.includes(fromId)) {
      await ctx.reply("Эта команда только для администратора клуба.");
      return;
    }
    const settings = db.getSettings();
    const now = Date.now();
    if (logic.isContestActive(settings, now)) {
      await ctx.reply("Конкурс уже идёт прямо сейчас. Сначала останови его командой /contest, потом планируй новый.");
      return;
    }
    const raw = (ctx.match || "").trim();
    const m = raw.match(/^(\d{4}-\d{2}-\d{2}[ T]\d{1,2}:\d{2})\s*([\s\S]*)$/);
    if (!m) {
      await ctx.reply(
        "Формат: /contest_at 2026-08-03 08:00 Текст приза\n" +
          "Дата и время — по времени Ижевска/Самары (UTC+4). Текст приза необязателен, но попадёт в анонс всем игрокам."
      );
      return;
    }
    const startTs = logic.parseClubDateTime(m[1]);
    if (startTs === null || Number.isNaN(startTs)) {
      await ctx.reply("Не смог разобрать дату и время. Формат: 2026-08-03 08:00");
      return;
    }
    const prizeText = m[2].trim();
    if (startTs <= now) {
      await startContestNow(now, prizeText);
      const hours = Math.round(logic.CONTEST_DURATION_MS / 3600000);
      await ctx.reply(`Указанное время уже наступило — конкурс запущен прямо сейчас, на ближайшие ${hours} часов.`);
      return;
    }
    db.setContestSchedule(startTs, prizeText);
    await ctx.reply(
      `Запланировал старт конкурса на ${logic.formatClubDateTime(startTs)}. ` +
        `Примерно в это время (± несколько минут — особенность бесплатного хостинга) всем игрокам-подписчикам бота ` +
        `придёт уведомление о старте, и включится безлимитный режим для всех, включая веб-ссылку.\n\n` +
        `Отменить план: отправь /contest_cancel.`
    );
  });

  bot.command("contest_cancel", async (ctx) => {
    const fromId = String(ctx.from.id);
    if (!ADMIN_IDS.includes(fromId)) {
      await ctx.reply("Эта команда только для администратора клуба.");
      return;
    }
    const settings = db.getSettings();
    if (!settings.contestScheduledStart) {
      await ctx.reply("Запланированного старта конкурса сейчас нет.");
      return;
    }
    db.setContestSchedule(null, null);
    await ctx.reply("Запланированный старт конкурса отменён.");
  });

  bot.command("leaderboard", async (ctx) => {
    const users = db.getAllUsers();
    const board = logic.buildLeaderboard(users);
    if (board.week.length === 0) {
      await ctx.reply("Пока никто не забивал голы на этой неделе — стань первым!");
      return;
    }
    const lines = board.week
      .slice(0, 10)
      .map((row, i) => `${i + 1}. ${row.name} — ${row.score} 🥅`)
      .join("\n");
    await ctx.reply(`🏆 Топ недели, ${CLUB_NAME}:\n\n${lines}`);
  });

  // Приватная статистика — видна только администратору (та же проверка
  // ADMIN_TELEGRAM_ID, что и у /matchday), в отличие от публичного /leaderboard.
  bot.command("stats", async (ctx) => {
    const fromId = String(ctx.from.id);
    if (ADMIN_IDS.length === 0) {
      await ctx.reply(
        "ADMIN_TELEGRAM_ID ещё не настроен на сервере — команда пока недоступна никому. " +
          "Узнай свой ID командой /myid и попроси администратора хостинга вписать его в настройки."
      );
      return;
    }
    if (!ADMIN_IDS.includes(fromId)) {
      await ctx.reply("Эта команда только для администратора клуба.");
      return;
    }
    const users = db.getAllUsers();
    const duels = db.getAllDuels();
    const stats = logic.buildStats(users, duels);
    const topLines = stats.topActive.length
      ? stats.topActive.map((u, i) => `${i + 1}. ${u.name} — ${u.totalGoals} 🥅`).join("\n")
      : "пока никто не играл";
    await ctx.reply(
      `📊 Статистика игры (видна только тебе)\n\n` +
        `Всего игроков: ${stats.totalPlayers}\n` +
        `— через Telegram: ${stats.fromTelegram}\n` +
        `— по обычной ссылке (VK/браузер): ${stats.fromWeb}\n\n` +
        `Новых сегодня: ${stats.newToday}\n` +
        `Играли сегодня: ${stats.playedToday}\n` +
        `Играли на этой неделе: ${stats.playedThisWeek}\n\n` +
        `Голов забито всего: ${stats.totalGoalsAllTime}\n` +
        `Дуэлей создано: ${stats.totalDuels} (сыграно до конца: ${stats.finishedDuels})\n\n` +
        `🏆 Топ по общему числу голов:\n${topLines}`
    );
  });

  bot.catch((err) => {
    console.error("Ошибка в боте:", err);
  });
}

// Правильное русское склонение "гол/гола/голов" по числу.
function goalsWord(n) {
  const abs = Math.abs(Math.round(n)) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return "голов";
  if (last === 1) return "гол";
  if (last >= 2 && last <= 4) return "гола";
  return "голов";
}

/**
 * Раз в день (не раньше DAILY_LEADER_NOTIFY_HOUR по времени клуба) находит
 * вчерашних "лидеров дня" (см. buildDailyLeaders в game-logic.js) и шлёт им
 * личное сообщение от бота с призывом сыграть ещё. Работает только для
 * Telegram-игроков — веб-гостям (VK/браузер) личное сообщение отправить
 * нельзя, для них вместо этого показывается баннер в самой игре (см. /api/auth).
 * lastLeaderNotifyDayKey в настройках защищает от повторной отправки в один
 * и тот же день при каждом периодическом тике.
 */
async function notifyDailyLeadersIfDue(now = Date.now()) {
  if (!bot) return;
  const todayKey = logic.dateKey(now);
  const settings = db.getSettings();
  if (settings.lastLeaderNotifyDayKey === todayKey) return;

  const clubHour = new Date(now + logic.CLUB_UTC_OFFSET_HOURS * 60 * 60 * 1000).getUTCHours();
  if (clubHour < DAILY_LEADER_NOTIFY_HOUR) return;

  const leaders = logic.buildDailyLeaders(db.getAllUsers(), now, DAILY_LEADER_TOP_N);
  for (const leader of leaders) {
    if (logic.isWebGuestId(leader.id)) continue; // им отправляется баннер в игре, не личное сообщение
    try {
      await bot.api.sendMessage(
        leader.id,
        `🔥 Вчера ты был лидером дня в «Забей гол» — ${leader.goals} ${goalsWord(leader.goals)}!\n\n` +
          `Попробуй сегодня повторить или улучшить результат — заходи в игру.`
      );
    } catch (err) {
      console.error(`Не удалось отправить напоминание лидеру дня (${leader.id}):`, err.message || err);
    }
  }
  db.setLastLeaderNotifyDayKey(todayKey);
}

function formatHallOfFameMessage(hof) {
  const fmtRows = (rows, unit) =>
    rows.length ? rows.map((r, i) => `${i + 1}. ${r.name} — ${r.value} ${unit}`).join("\n") : "пока пусто";
  return (
    `🏛 Зал славы клуба — «Забей гол»\n\n` +
    `🥅 Лучший результат за матч:\n${fmtRows(hof.bestMatch, "гол")}\n\n` +
    `🔥 Самый длинный стрик подряд:\n${fmtRows(hof.longestStreak, "дн.")}\n\n` +
    `⚽ Больше всего голов за всё время:\n${fmtRows(hof.totalGoals, "гол")}\n\n` +
    `Заходи почаще — может, следующим в зале славы будешь ты!`
  );
}

/**
 * Раз в неделю (по понедельникам, не раньше HALL_OF_FAME_NOTIFY_HOUR по
 * времени клуба) шлёт ВСЕМ Telegram-игрокам сводку зала славы — просто для
 * мотивации, а не личное достижение конкретного человека (в отличие от
 * "лидера дня"), поэтому уходит всем сразу, а не только тем, кто в топе.
 * Веб-гостям вместо рассылки — баннер в игре (см. /api/auth).
 */
async function notifyHallOfFameIfDue(now = Date.now()) {
  if (!bot) return;
  const curWeek = logic.weekKey(now);
  const settings = db.getSettings();
  if (settings.lastHallOfFameNotifyWeekKey === curWeek) return;

  const shifted = new Date(now + logic.CLUB_UTC_OFFSET_HOURS * 60 * 60 * 1000);
  if (shifted.getUTCDay() !== HALL_OF_FAME_NOTIFY_WEEKDAY) return;
  if (shifted.getUTCHours() < HALL_OF_FAME_NOTIFY_HOUR) return;

  const users = db.getAllUsers();
  const hof = logic.buildHallOfFame(users, HALL_OF_FAME_TOP_N);
  const text = formatHallOfFameMessage(hof);
  for (const u of users) {
    if (logic.isWebGuestId(u.id)) continue;
    try {
      await bot.api.sendMessage(u.id, text);
    } catch (err) {
      console.error(`Не удалось отправить зал славы игроку (${u.id}):`, err.message || err);
    }
  }
  db.setLastHallOfFameNotifyWeekKey(curWeek);
}

/** Разослать анонс старта конкурса всем Telegram-игрокам (веб-гостям не достучаться — у них нет chat-id). */
async function broadcastContestStart(hours, prizeText) {
  if (!bot) return;
  const users = db.getAllUsers();
  const prizeLine = prizeText ? `\n\n🏅 Приз: ${prizeText}` : "";
  const text =
    `🏆 Стартовал конкурс дня в «Забей гол»!\n\n` +
    `Ближайшие ${hours} часов — неограниченные попытки, играй сколько хочешь. ` +
    `Голы за это время считаются отдельно от обычного рейтинга.` +
    prizeLine +
    `\n\nУдачи!`;
  for (const u of users) {
    if (logic.isWebGuestId(u.id)) continue;
    try {
      await bot.api.sendMessage(u.id, text);
    } catch (err) {
      console.error(`Не удалось отправить анонс конкурса игроку (${u.id}):`, err.message || err);
    }
  }
}

/** Запускает конкурс прямо сейчас (из /contest, /contest_at или автостарта по расписанию) и рассылает анонс. */
async function startContestNow(now, prizeText) {
  db.setContestStart(now);
  db.setContestSchedule(null, null);
  const hours = Math.round(logic.CONTEST_DURATION_MS / 3600000);
  await broadcastContestStart(hours, prizeText);
}

/** Проверяет, не пора ли автоматически стартовать заранее запланированный конкурс (см. /contest_at). */
async function startScheduledContestIfDue(now = Date.now()) {
  if (!bot) return;
  const settings = db.getSettings();
  if (!settings.contestScheduledStart) return;
  if (logic.isContestActive(settings, now)) return;
  if (now < settings.contestScheduledStart) return;
  await startContestNow(now, settings.contestScheduledPrizeText || "");
}

/** Личное сообщение участнику конкурса с его результатом — в дополнение к сводке администратору. */
function formatParticipantContestMessage(participant, results, reasonText) {
  const rank = results.findIndex((r) => r.id === participant.id) + 1;
  const isWinner = rank === 1;
  const medal = rank === 1 ? "🥇" : rank === 2 ? "🥈" : rank === 3 ? "🥉" : `${rank}.`;
  const top = results
    .slice(0, 5)
    .map((r, i) => {
      const m = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `${i + 1}.`;
      return `${m} ${r.name} — ${r.goals} ${goalsWord(r.goals)}`;
    })
    .join("\n");
  const personalLine = isWinner
    ? `🎉 Поздравляем — ты первый, ${participant.goals} ${goalsWord(participant.goals)}! Скоро с тобой свяжутся насчёт приза.`
    : `Твой результат: ${medal} место, ${participant.goals} ${goalsWord(participant.goals)}.`;
  return (
    `🏁 Конкурс дня завершён (${reasonText})!\n\n${personalLine}\n\nТоп участников:\n${top}\n\n` +
    `Спасибо, что играл — впереди ещё будут конкурсы!`
  );
}

function formatContestResultsMessage(results, reasonText) {
  if (!results.length) {
    return `🏁 Конкурс дня завершён (${reasonText}) — но за это время никто не забил ни одного гола.`;
  }
  const lines = results
    .map((r, i) => {
      const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `${i + 1}.`;
      const platformNote = r.isTelegram ? "" : " (не из Telegram — см. ниже)";
      return `${medal} ${r.name} — ${r.goals} ${goalsWord(r.goals)}${platformNote}`;
    })
    .join("\n");
  const winner = results[0];
  const winnerNote = winner.isTelegram
    ? ""
    : "\n\nПобедитель зашёл не через Telegram — у игры нет его контактов, только имя. " +
      "Чтобы вручить приз, дождись, пока он сам напишет тебе (в объявлении о конкурсе стоит явно попросить об этом), " +
      "и, как обычно, попроси скриншот/видео результата перед вручением.";
  return (
    `🏁 Конкурс дня завершён (${reasonText})!\n\n` +
    `Участников с забитыми голами: ${results.length}\n\n${lines}\n\n` +
    `Победитель: ${winner.name} — ${winner.goals} ${goalsWord(winner.goals)}.${winnerNote}`
  );
}

/** Завершает конкурс (сейчас, независимо от того, истекли ли честные 24 часа
 * или админ остановил досрочно), шлёт итоги всем ADMIN_IDS в личку и
 * деактивирует settings.contestStartTs. */
async function finalizeContestNow(contestStartTs, reasonText) {
  const users = db.getAllUsers();
  const results = logic.buildContestResults(users, contestStartTs);
  const text = formatContestResultsMessage(results, reasonText);
  db.setContestStart(null);
  if (bot) {
    for (const adminId of ADMIN_IDS) {
      try {
        await bot.api.sendMessage(adminId, text);
      } catch (err) {
        console.error(`Не удалось отправить итоги конкурса дня админу (${adminId}):`, err.message || err);
      }
    }
    // Участникам из Telegram (веб-гостям не достучаться) — тоже присылаем
    // персональный итог, чтобы держать их в игре и не молчать про результат.
    for (const r of results) {
      if (!r.isTelegram) continue;
      if (ADMIN_IDS.includes(String(r.id))) continue; // админ уже получил полную сводку выше
      try {
        await bot.api.sendMessage(r.id, formatParticipantContestMessage(r, results, reasonText));
      } catch (err) {
        console.error(`Не удалось отправить итоги конкурса участнику (${r.id}):`, err.message || err);
      }
    }
  }
}

/** Автозавершение конкурса по истечении ровно CONTEST_DURATION_MS — проверяется тем же периодическим тиком, что и остальные рассылки. */
async function finalizeContestIfDue(now = Date.now()) {
  if (!bot) return;
  const settings = db.getSettings();
  if (!settings.contestStartTs) return;
  if (now < settings.contestStartTs + logic.CONTEST_DURATION_MS) return;
  await finalizeContestNow(settings.contestStartTs, "истекли отведённые 24 часа");
}

async function main() {
  if (bot) {
    try {
      const me = await bot.api.getMe();
      botUsername = me.username;
    } catch (err) {
      console.error("Не удалось узнать username бота (ссылки на дуэль не будут работать):", err);
    }
    if (PUBLIC_URL) {
      // Продакшен-режим: вебхук — экономичнее для бесплатных хостингов,
      // которые "усыпляют" сервис при простое (Render free tier и т.п.).
      const webhookPath = `/bot${BOT_TOKEN}`;
      app.use(webhookPath, webhookCallback(bot, "express"));
      app.listen(PORT, async () => {
        console.log(`Сервер слушает порт ${PORT}`);
        try {
          await bot.api.setWebhook(`${PUBLIC_URL}${webhookPath}`);
          console.log("Webhook установлен:", `${PUBLIC_URL}${webhookPath}`);
        } catch (err) {
          console.error("Не удалось установить webhook:", err);
        }
      });
    } else {
      // Локальная разработка: обычный long polling, вебхук не нужен.
      app.listen(PORT, () => {
        console.log(`Сервер слушает порт ${PORT} (без PUBLIC_URL — бот запущен в режиме polling)`);
      });
      bot.start();
    }
  } else {
    app.listen(PORT, () => {
      console.log(`Сервер слушает порт ${PORT} (BOT_TOKEN не задан, бот выключен)`);
    });
  }
}

main();

// Проверяем раз в 10 минут — той же периодичности достаточно, точность в
// пределах часа тут не критична, а внешний "будильник" (см. README), который
// пингует /healthz, всё равно не даёт бесплатному хостингу уснуть в это время.
function runPeriodicChecks() {
  notifyDailyLeadersIfDue().catch((err) => console.error("Ошибка рассылки лидерам дня:", err));
  notifyHallOfFameIfDue().catch((err) => console.error("Ошибка рассылки зала славы:", err));
  startScheduledContestIfDue().catch((err) => console.error("Ошибка автостарта запланированного конкурса дня:", err));
  finalizeContestIfDue().catch((err) => console.error("Ошибка автозавершения конкурса дня:", err));
}

if (bot) {
  runPeriodicChecks();
  setInterval(runPeriodicChecks, 10 * 60 * 1000);
}

module.exports = app;
// Дополнительно вешаем на экспорт сами джобы рассылок/автозавершения —
// нужно только для тестов (см. test-daily-leaders.js, test-contest.js), в
// проде используется app как обычно.
module.exports.notifyDailyLeadersIfDue = notifyDailyLeadersIfDue;
module.exports.notifyHallOfFameIfDue = notifyHallOfFameIfDue;
module.exports.finalizeContestIfDue = finalizeContestIfDue;
module.exports.finalizeContestNow = finalizeContestNow;
module.exports.startContestNow = startContestNow;
module.exports.startScheduledContestIfDue = startScheduledContestIfDue;
