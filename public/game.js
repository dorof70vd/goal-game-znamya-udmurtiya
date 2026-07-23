// «Забей гол» — простая аркада для Telegram Mini App.
// Управление: зажать в поле экрана (растёт сила), вести пальцем — прицел
// (влево/вправо — куда бить, вверх — пробить понизу или "верхом" в девятку),
// отпустить — удар. Вратарь пытается среагировать по своей сложности уровня.

(function () {
  "use strict";

  const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
  if (tg) {
    tg.ready();
    tg.expand();
    if (tg.setHeaderColor) try { tg.setHeaderColor("#8f1418"); } catch (_) {}
  }

  function getInitData() {
    if (tg && tg.initData) return tg.initData;
    // Режим локальной разработки вне Telegram: ?dev=12345
    const params = new URLSearchParams(location.search);
    const devId = params.get("dev");
    if (devId) return `dev:${devId}`;
    return "";
  }

  const initData = getInitData();

  const el = {
    overlay: document.getElementById("overlay"),
    overlayTitle: document.getElementById("overlayTitle"),
    overlayText: document.getElementById("overlayText"),
    overlayBtn: document.getElementById("overlayBtn"),
    overlayBtn2: document.getElementById("overlayBtn2"),
    overlayBtn3: document.getElementById("overlayBtn3"),
    energyStat: document.getElementById("energyStat"),
    streakStat: document.getElementById("streakStat"),
    levelStat: document.getElementById("levelStat"),
    hud: document.getElementById("hud"),
    streakBadge: document.getElementById("streakBadge"),
    powerBar: document.getElementById("powerBar"),
    footer: document.getElementById("footerText"),
  };

  const canvas = document.getElementById("game");
  const ctx = canvas.getContext("2d");

  let dpr = Math.max(1, window.devicePixelRatio || 1);
  let W = 0, H = 0;
  function resize() {
    const rect = canvas.parentElement.getBoundingClientRect();
    W = rect.width; H = rect.height;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  window.addEventListener("resize", resize);
  resize();

  async function api(path, body) {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ initData, ...body }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || "REQUEST_FAILED");
      err.payload = data;
      throw err;
    }
    return data;
  }

  function fmtMs(ms) {
    const m = Math.ceil(ms / 60000);
    if (m < 60) return `${m} мин`;
    const h = Math.floor(m / 60);
    const mm = m % 60;
    return `${h} ч ${mm} мин`;
  }

  function updateHudFromState(state) {
    if (state.matchDayActive) {
      el.energyStat.textContent = `⚡ ∞ (день матча!)`;
    } else if (state.energy > state.maxEnergy) {
      el.energyStat.textContent = `⚡ ${state.energy} (есть бонус!)`;
    } else {
      el.energyStat.textContent = `⚡ ${state.energy}/${state.maxEnergy}`;
    }
    el.streakStat.textContent = `🔥 ${state.streak} дн. подряд`;
    el.levelStat.textContent = `🏒 Соперник №${state.level}`;
  }

  // ------------------------- Игровое состояние ---------------------------

  const GOAL = { top: 0, bottom: 0, left: 0, right: 0 }; // пересчитывается в layout()
  const SLOTS = ["farLeft", "left", "center", "right", "farRight"];

  let currentUser = null;
  let match = null; // { token, difficulty, shotsPerMatch }
  let shotIndex = 0;
  let goalsScored = 0;
  let keeperX = 0.5; // 0..1 по ширине ворот
  let keeperDive = null; // {target, startTs, duration}
  let ball = null; // {x,y, targetX, targetY, startTs, duration, resolved, slot, high}
  let charging = false;
  let chargeStart = 0;
  let aimStart = null;
  let aimCurrent = null;
  let lastResult = null; // 'goal' | 'save' | 'miss'
  let resultTimer = null;

  function layout() {
    GOAL.left = W * 0.14;
    GOAL.right = W * 0.86;
    GOAL.top = H * 0.16;
    GOAL.bottom = H * 0.42;
  }

  function slotToX(slot) {
    const idx = SLOTS.indexOf(slot);
    const t = idx / (SLOTS.length - 1);
    return GOAL.left + t * (GOAL.right - GOAL.left);
  }

  function pickSlotFromDx(dx) {
    // dx в диапазоне примерно [-1, 1]
    const clamped = Math.max(-1, Math.min(1, dx));
    const idx = Math.round(((clamped + 1) / 2) * (SLOTS.length - 1));
    return SLOTS[Math.max(0, Math.min(SLOTS.length - 1, idx))];
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);

    // Каток
    const rinkGrad = ctx.createLinearGradient(0, 0, 0, H);
    rinkGrad.addColorStop(0, "#cfe8ff");
    rinkGrad.addColorStop(1, "#eef6ff");
    ctx.fillStyle = rinkGrad;
    ctx.fillRect(0, 0, W, H);

    // Ворота (штанги)
    ctx.strokeStyle = "#c1272d";
    ctx.lineWidth = 6;
    ctx.strokeRect(GOAL.left, GOAL.top, GOAL.right - GOAL.left, GOAL.bottom - GOAL.top);
    ctx.fillStyle = "rgba(255,255,255,0.35)";
    ctx.fillRect(GOAL.left, GOAL.top, GOAL.right - GOAL.left, GOAL.bottom - GOAL.top);
    // Сетка
    ctx.strokeStyle = "rgba(140,20,25,0.25)";
    ctx.lineWidth = 1;
    for (let i = 1; i < 6; i++) {
      const x = GOAL.left + (i / 6) * (GOAL.right - GOAL.left);
      ctx.beginPath(); ctx.moveTo(x, GOAL.top); ctx.lineTo(x, GOAL.bottom); ctx.stroke();
    }
    for (let i = 1; i < 3; i++) {
      const y = GOAL.top + (i / 3) * (GOAL.bottom - GOAL.top);
      ctx.beginPath(); ctx.moveTo(GOAL.left, y); ctx.lineTo(GOAL.right, y); ctx.stroke();
    }

    // Вратарь
    const kx = GOAL.left + keeperX * (GOAL.right - GOAL.left);
    const ky = GOAL.top + (GOAL.bottom - GOAL.top) * 0.55;
    ctx.fillStyle = "#222";
    ctx.fillRect(kx - 22, ky - 26, 44, 52);
    ctx.fillStyle = "#c1272d";
    ctx.fillRect(kx - 22, ky - 26, 44, 10);
    ctx.fillStyle = "#ffe0b2";
    ctx.beginPath(); ctx.arc(kx, ky - 32, 12, 0, Math.PI * 2); ctx.fill();

    // Игрок/точка удара (низ поля)
    const px = W / 2, py = H * 0.9;
    ctx.fillStyle = "#8f1418";
    ctx.beginPath(); ctx.arc(px, py, 10, 0, Math.PI * 2); ctx.fill();

    // Мяч
    if (ball) {
      const t = Math.min(1, (performance.now() - ball.startTs) / ball.duration);
      const ease = 1 - Math.pow(1 - t, 3);
      const bx = px + (ball.targetX - px) * ease;
      const by = py + (ball.targetY - py) * ease - Math.sin(Math.PI * ease) * (ball.high ? 46 : 14);
      ctx.fillStyle = "#111";
      ctx.beginPath(); ctx.arc(bx, by, 7, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.5; ctx.stroke();
      if (t >= 1 && !ball.resolved) {
        resolveShot();
      }
    } else {
      ctx.fillStyle = "#111";
      ctx.beginPath(); ctx.arc(px, py - 14, 7, 0, Math.PI * 2); ctx.fill();
    }

    // Прицел во время замаха
    if (charging && aimCurrent) {
      const dx = (aimCurrent.x - aimStart.x) / (W * 0.35);
      const slot = pickSlotFromDx(dx);
      const tx = slotToX(slot);
      ctx.strokeStyle = "rgba(193,39,45,0.8)";
      ctx.setLineDash([6, 6]);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(px, py - 14);
      ctx.lineTo(tx, GOAL.top + (GOAL.bottom - GOAL.top) * 0.5);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    if (lastResult) {
      ctx.font = "bold 26px sans-serif";
      ctx.textAlign = "center";
      ctx.fillStyle = lastResult === "goal" ? "#1a7a2e" : "#8f1418";
      ctx.fillText(lastResult === "goal" ? "ГОЛ!" : lastResult === "save" ? "ВЫШЕ! Вратарь взял" : "МИМО", W / 2, H * 0.7);
    }

    requestAnimationFrame(draw);
  }
  requestAnimationFrame(draw);

  function startKeeperDive(targetSlot, difficulty) {
    let guessSlot = targetSlot;
    const correctGuess = Math.random() < difficulty.coverage;
    if (!correctGuess || Math.random() < difficulty.feintChance) {
      const others = SLOTS.filter((s) => s !== targetSlot);
      guessSlot = others[Math.floor(Math.random() * others.length)];
    }
    keeperDive = {
      from: keeperX,
      to: (SLOTS.indexOf(guessSlot)) / (SLOTS.length - 1),
      startTs: performance.now(),
      duration: difficulty.reactionMs,
      guessSlot,
    };
    const tick = () => {
      if (!keeperDive) return;
      const t = Math.min(1, (performance.now() - keeperDive.startTs) / keeperDive.duration);
      keeperX = keeperDive.from + (keeperDive.to - keeperDive.from) * t;
      if (t < 1) requestAnimationFrame(tick);
    };
    tick();
  }

  function resolveShot() {
    ball.resolved = true;
    const savedZoneMatches = keeperDive && keeperDive.guessSlot === ball.slot;
    let result;
    if (ball.tooWeak) {
      result = "miss";
    } else if (savedZoneMatches && !(ball.high && Math.random() < 0.35)) {
      result = "save";
    } else {
      result = "goal";
      goalsScored += 1;
    }
    lastResult = result;
    clearTimeout(resultTimer);
    resultTimer = setTimeout(() => {
      lastResult = null;
      nextShotOrFinish();
    }, 850);
  }

  function nextShotOrFinish() {
    ball = null;
    keeperDive = null;
    keeperX = 0.5;
    shotIndex += 1;
    if (shotIndex >= match.shotsPerMatch) {
      finishMatch();
    } else {
      el.footer.textContent = `Удар ${shotIndex + 1} из ${match.shotsPerMatch} — зажми и веди пальцем, отпусти для удара.`;
    }
  }

  function shoot(dxRaw, dyRaw, power) {
    const dx = dxRaw / (W * 0.35);
    const slot = pickSlotFromDx(dx);
    const high = dyRaw < -H * 0.05;
    const tooWeak = power < 0.18;

    const px = W / 2, py = H * 0.9;
    ball = {
      startTs: performance.now(),
      duration: 380 - power * 120,
      targetX: slotToX(slot),
      targetY: GOAL.top + (GOAL.bottom - GOAL.top) * (high ? 0.15 : 0.6),
      high,
      slot,
      tooWeak,
      resolved: false,
    };
    startKeeperDive(slot, match.difficulty);
  }

  // ------------------------- Управление (pointer) -------------------------

  canvas.addEventListener("pointerdown", (e) => {
    if (!match || ball) return;
    charging = true;
    chargeStart = performance.now();
    aimStart = { x: e.clientX, y: e.clientY };
    aimCurrent = { x: e.clientX, y: e.clientY };
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!charging) return;
    aimCurrent = { x: e.clientX, y: e.clientY };
    const power = Math.min(1, (performance.now() - chargeStart) / 900);
    el.powerBar.style.height = `${power * 100}%`;
  });
  function release(e) {
    if (!charging) return;
    charging = false;
    const power = Math.min(1, (performance.now() - chargeStart) / 900);
    el.powerBar.style.height = "0%";
    const dx = (e.clientX ?? aimCurrent.x) - aimStart.x;
    const dy = (e.clientY ?? aimCurrent.y) - aimStart.y;
    shoot(dx, dy, Math.max(power, 0.05));
  }
  canvas.addEventListener("pointerup", release);
  canvas.addEventListener("pointercancel", () => { charging = false; el.powerBar.style.height = "0%"; });

  // ------------------------------- Матч flow -------------------------------

  function showOverlay({ title, text, btnLabel, btn2Label, btn3Label, onBtn, onBtn2, onBtn3 }) {
    el.overlay.classList.remove("hidden");
    el.overlayTitle.textContent = title;
    el.overlayText.textContent = text;
    el.overlayBtn.style.display = btnLabel ? "inline-block" : "none";
    el.overlayBtn.textContent = btnLabel || "";
    el.overlayBtn.onclick = onBtn || null;
    el.overlayBtn2.style.display = btn2Label ? "inline-block" : "none";
    el.overlayBtn2.textContent = btn2Label || "";
    el.overlayBtn2.onclick = onBtn2 || null;
    el.overlayBtn3.style.display = btn3Label ? "inline-block" : "none";
    el.overlayBtn3.textContent = btn3Label || "";
    el.overlayBtn3.onclick = onBtn3 || null;
  }
  function hideOverlay() { el.overlay.classList.add("hidden"); }

  async function showLeaderboard() {
    const board = await fetch("/api/leaderboard").then((r) => r.json());
    const lines = board.week.length
      ? board.week.slice(0, 10).map((r, i) => `${i + 1}. ${r.name} — ${r.score}`).join("\n")
      : "Пока пусто — стань первым!";
    showOverlay({
      title: "🏆 Топ недели",
      text: lines,
      btnLabel: "Назад",
      onBtn: () => renderHome(),
    });
  }

  async function claimNewsBonus() {
    try {
      const res = await api("/api/bonus/news", {});
      currentUser = res;
      updateHudFromState(currentUser);
      if (currentUser.newsUrl && tg && tg.openLink) {
        tg.openLink(currentUser.newsUrl);
      } else if (currentUser.newsUrl) {
        window.open(currentUser.newsUrl, "_blank");
      }
      renderHome();
    } catch (err) {
      renderHome();
    }
  }

  function renderHome() {
    if (!currentUser) return;
    const newsBtn = currentUser.newsBonusAvailable ? "📰 +2 попытки за новость клуба" : null;

    if (!currentUser.matchDayActive && currentUser.energy < 1) {
      showOverlay({
        title: "Энергия закончилась",
        text: `Следующая попытка через ${fmtMs(currentUser.msUntilNextEnergy)}. Заходи завтра — получишь бонус за стрик!` +
          (newsBtn ? " А пока можно почитать новость клуба и получить ещё попытки." : ""),
        btn2Label: "Таблица лидеров",
        onBtn2: showLeaderboard,
        btn3Label: newsBtn,
        onBtn3: claimNewsBonus,
      });
      return;
    }
    showOverlay({
      title: currentUser.matchDayActive ? `⚡ День матча — попытки безлимитны!` : `Соперник №${currentUser.level}`,
      text: currentUser.matchDayActive
        ? `Сегодня день игры клуба — забивай сколько хочешь! Соперник №${currentUser.level}.`
        : `У тебя ${currentUser.energy} попыток. Забей все ${currentUser.shotsPerMatch} — откроешь следующего соперника!`,
      btnLabel: "Играть",
      btn2Label: "Таблица лидеров",
      onBtn: startMatchFlow,
      onBtn2: showLeaderboard,
      btn3Label: newsBtn,
      onBtn3: claimNewsBonus,
    });
  }

  async function startMatchFlow() {
    try {
      const res = await api("/api/match/start", {});
      match = res;
      shotIndex = 0;
      goalsScored = 0;
      hideOverlay();
      el.footer.textContent = `Удар 1 из ${match.shotsPerMatch} — зажми и веди пальцем, отпусти для удара.`;
    } catch (err) {
      if (err.payload && err.payload.error === "NO_ENERGY") {
        currentUser.energy = 0;
        currentUser.msUntilNextEnergy = err.payload.msUntilNextEnergy;
        renderHome();
      } else {
        showOverlay({ title: "Не получилось", text: "Проверь соединение и попробуй ещё раз.", btnLabel: "Ок", onBtn: renderHome });
      }
    }
  }

  async function finishMatch() {
    try {
      const res = await api("/api/match/result", { token: match.token, goals: goalsScored });
      currentUser = res;
      updateHudFromState(currentUser);
      const perfect = res.perfect;
      showOverlay({
        title: perfect ? "Идеальный матч! 🎉" : `Забито ${goalsScored} из ${match.shotsPerMatch}`,
        text: perfect
          ? `Следующий соперник: №${res.level}. Расскажи друзьям в чате клуба!`
          : `Попробуй выбить все ${match.shotsPerMatch} — это откроет следующего соперника.`,
        btnLabel: (currentUser.matchDayActive || currentUser.energy >= 1) ? "Играть ещё" : undefined,
        btn2Label: "Поделиться результатом",
        onBtn: startMatchFlow,
        onBtn2: shareResult,
      });
      if (!currentUser.matchDayActive && currentUser.energy < 1) {
        setTimeout(renderHome, 50);
      }
    } catch (err) {
      showOverlay({ title: "Ошибка", text: "Не удалось сохранить результат матча.", btnLabel: "Ок", onBtn: renderHome });
    } finally {
      match = null;
    }
  }

  function shareResult() {
    const text = `Забил ${goalsScored} из ${match ? match.shotsPerMatch : 5} в игре «Забей гол» ХК «Знамя-Удмуртия» 🔴⚪ Стрик: ${currentUser.streak} дней. Заходи сыграть!`;
    const botUrl = (window.GOAL_GAME_BOT_URL || "").trim();
    const shareUrl = botUrl
      ? `https://t.me/share/url?url=${encodeURIComponent(botUrl)}&text=${encodeURIComponent(text)}`
      : null;
    if (tg && shareUrl) {
      tg.openTelegramLink(shareUrl);
    } else if (navigator.share) {
      navigator.share({ text }).catch(() => {});
    } else {
      window.prompt("Скопируй и отправь друзьям:", text);
    }
  }

  // ------------------------------- Запуск -------------------------------

  async function init() {
    layout();
    if (!initData) {
      showOverlay({
        title: "Открой через Telegram",
        text: "Эта игра работает как мини-приложение внутри Telegram. Открой её по кнопке у бота клуба.",
      });
      return;
    }
    try {
      const state = await api("/api/auth", {});
      currentUser = state;
      updateHudFromState(state);
      renderHome();
    } catch (err) {
      showOverlay({ title: "Не удалось подключиться", text: "Попробуй перезайти в игру через кнопку бота.", });
    }
  }

  window.addEventListener("load", () => { layout(); init(); });
})();
