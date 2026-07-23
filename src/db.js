// Простое персистентное хранилище на JSON-файле.
// Никаких нативных зависимостей — идеально ложится на любой бесплатный хостинг
// (Render/Railway/VPS) без шага компиляции.
//
// ВАЖНО: подходит для нагрузки в масштабах фан-базы одного клуба
// (десятки/сотни одновременных игроков). Если аудитория вырастет на порядки —
// можно будет заменить этот модуль на настоящую БД (Postgres), не трогая
// остальной код: наружу торчат только функции ниже.

const fs = require("fs");
const path = require("path");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const DB_FILE = path.join(DATA_DIR, "db.json");

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function emptyState() {
  return { users: {}, settings: { matchDayKey: null }, duels: {} };
}

function loadRaw() {
  ensureDataDir();
  if (!fs.existsSync(DB_FILE)) {
    return emptyState();
  }
  try {
    const raw = fs.readFileSync(DB_FILE, "utf8");
    if (!raw.trim()) return emptyState();
    const parsed = JSON.parse(raw);
    if (!parsed.settings) parsed.settings = { matchDayKey: null };
    if (!parsed.duels) parsed.duels = {};
    return parsed;
  } catch (err) {
    console.error("Не удалось прочитать db.json, начинаю с чистого состояния:", err);
    return emptyState();
  }
}

let state = loadRaw();
let saveScheduled = false;

function persist() {
  if (saveScheduled) return;
  saveScheduled = true;
  // Небольшой дебаунс, чтобы не писать на диск при каждом мелком мутировании подряд.
  setTimeout(() => {
    saveScheduled = false;
    ensureDataDir();
    const tmpFile = DB_FILE + ".tmp";
    fs.writeFileSync(tmpFile, JSON.stringify(state, null, 2), "utf8");
    fs.renameSync(tmpFile, DB_FILE);
  }, 50);
}

function getUser(telegramId) {
  const id = String(telegramId);
  return state.users[id] || null;
}

function getOrCreateUser(telegramId, profile = {}) {
  const id = String(telegramId);
  if (!state.users[id]) {
    state.users[id] = {
      id,
      username: profile.username || null,
      firstName: profile.firstName || null,
      photoUrl: profile.photoUrl || null, // фото профиля Telegram — для аватарки в лидерборде
      energy: 8,
      maxEnergy: 8,
      lastEnergyTs: Date.now(),
      streak: 0,
      lastPlayedDate: null, // "YYYY-MM-DD" в таймзоне клуба
      lastNewsBonusDate: null, // "YYYY-MM-DD" — когда последний раз забирали бонус за новость
      lastVkBonusDate: null, // то же самое для бонуса за подписку на VK
      lastMaxBonusDate: null, // то же самое для бонуса за подписку на MAX
      level: 1,
      bestScore: 0,
      totalGoals: 0,
      weekGoals: 0,
      weekKey: null, // "YYYY-Www"
      achievements: [], // id значков (см. game-logic.js ACHIEVEMENTS)
      createdAt: Date.now(),
    };
    persist();
  } else {
    // Обновим отображаемое имя, если поменялось
    if (profile.username && state.users[id].username !== profile.username) {
      state.users[id].username = profile.username;
      persist();
    }
    if (profile.firstName && state.users[id].firstName !== profile.firstName) {
      state.users[id].firstName = profile.firstName;
      persist();
    }
    if (profile.photoUrl && state.users[id].photoUrl !== profile.photoUrl) {
      state.users[id].photoUrl = profile.photoUrl;
      persist();
    }
  }
  return state.users[id];
}

function saveUser(user) {
  state.users[user.id] = user;
  persist();
}

function getAllUsers() {
  return Object.values(state.users);
}

function getSettings() {
  return state.settings;
}

/** Включает/выключает безлимитный режим на сегодня. dateKeyOrNull — строка "YYYY-MM-DD" или null. */
function setMatchDay(dateKeyOrNull) {
  state.settings.matchDayKey = dateKeyOrNull;
  persist();
}

function getDuel(id) {
  return state.duels[id] || null;
}

function saveDuel(duel) {
  state.duels[duel.id] = duel;
  persist();
}

function getAllDuels() {
  return Object.values(state.duels);
}

module.exports = {
  getUser,
  getOrCreateUser,
  saveUser,
  getAllUsers,
  getSettings,
  setMatchDay,
  getDuel,
  saveDuel,
  getAllDuels,
};
