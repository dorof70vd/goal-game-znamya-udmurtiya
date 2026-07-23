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
// Telegram-ID администратора(ов), которым можно включать безлимит в дни матчей.
// Через запятую, если их несколько. Свой ID можно узнать командой /myid у бота.
const ADMIN_IDS = (process.env.ADMIN_TELEGRAM_ID || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

if (!BOT_TOKEN) {
  console.warn(
    "[WARN] BOT_TOKEN не задан. Сайт мини-аппа и API поднимутся, но бот работать не будет.\n" +
      "Смотри .env.example и инструкцию BOTFATHER.md."
  );
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

function authOrFail(req, res) {
  const initData = req.body?.initData || req.query?.initData;
  const check = verifyInitDataOrDev(initData, BOT_TOKEN);
  if (!check.ok) {
    res.status(401).json({ error: "AUTH_FAILED", reason: check.reason });
    return null;
  }
  return check.user;
}

function serializeUser(user, now) {
  logic.applyEnergyRegen(user, now);
  logic.ensureCurrentWeek(user, now);
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
    club: CLUB_NAME,
    matchDayActive,
    newsBonusAvailable: Boolean(NEWS_URL) && logic.isNewsBonusAvailable(user, now),
    newsUrl: NEWS_URL || null,
  };
}

// --- API ---------------------------------------------------------------

app.post("/api/auth", (req, res) => {
  const tgUser = authOrFail(req, res);
  if (!tgUser) return;
  const now = Date.now();

  const user = db.getOrCreateUser(tgUser.id, {
    username: tgUser.username,
    firstName: tgUser.first_name,
  });

  logic.applyEnergyRegen(user, now);
  const loginResult = logic.registerDailyLogin(user, now);
  logic.ensureCurrentWeek(user, now);
  const newAchievements = logic.checkAchievements(user, {});
  db.saveUser(user);

  res.json({
    ...serializeUser(user, now),
    dailyBonus: loginResult,
    newAchievements,
    achievementCatalog: logic.ACHIEVEMENTS,
  });
});

app.get("/api/leaderboard", (req, res) => {
  const now = Date.now();
  const users = db.getAllUsers();
  res.json(logic.buildLeaderboard(users, now));
});

app.post("/api/match/start", (req, res) => {
  const tgUser = authOrFail(req, res);
  if (!tgUser) return;
  const now = Date.now();
  const user = db.getOrCreateUser(tgUser.id, {});
  logic.applyEnergyRegen(user, now);
  const unlimited = logic.isMatchDayActive(db.getSettings(), now);

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

app.post("/api/bonus/news", (req, res) => {
  const tgUser = authOrFail(req, res);
  if (!tgUser) return;
  if (!NEWS_URL) {
    return res.status(400).json({ error: "NEWS_BONUS_NOT_CONFIGURED" });
  }
  const now = Date.now();
  const user = db.getOrCreateUser(tgUser.id, {});
  logic.applyEnergyRegen(user, now);
  const bonus = logic.claimNewsBonus(user, now);
  db.saveUser(user);
  res.json({ ...bonus, ...serializeUser(user, now) });
});

app.post("/api/match/result", (req, res) => {
  const tgUser = authOrFail(req, res);
  if (!tgUser) return;
  const { token, goals } = req.body || {};
  const now = Date.now();
  const user = db.getOrCreateUser(tgUser.id, {});

  try {
    const result = logic.submitMatchResult(user, token, Number(goals), now);
    db.saveUser(user);
    res.json({ ...result, ...serializeUser(user, now) });
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
  res.json({
    duelId: duel.id,
    shareUrl,
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

  bot.catch((err) => {
    console.error("Ошибка в боте:", err);
  });
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

module.exports = app;
