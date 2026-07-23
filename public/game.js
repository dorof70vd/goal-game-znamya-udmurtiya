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
    overlayBtn4: document.getElementById("overlayBtn4"),
    overlayBtn5: document.getElementById("overlayBtn5"),
    overlayBtn6: document.getElementById("overlayBtn6"),
    overlayList: document.getElementById("overlayList"),
    energyStat: document.getElementById("energyStat"),
    streakStat: document.getElementById("streakStat"),
    diffStat: document.getElementById("diffStat"),
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
    const modeIcon = state.mode === "defense" ? "🧤" : "⚽";
    el.levelStat.textContent = `${modeIcon} ${state.opponentName || ("Соперник №" + state.level)}`;
    if (state.difficulty && state.difficulty.tier) {
      el.diffStat.textContent = `🎯 ${state.difficulty.tier}`;
      el.diffStat.style.display = "";
    } else {
      el.diffStat.style.display = "none";
    }
  }

  // ------------------------- Звуки (Web Audio, без файлов) ----------------

  let audioCtx = null;
  function ensureAudio() {
    if (audioCtx) return audioCtx;
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    } catch (_) {
      audioCtx = null;
    }
    return audioCtx;
  }
  function playTone(freq, duration, type, vol) {
    const ac = ensureAudio();
    if (!ac) return;
    try {
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.type = type || "sine";
      osc.frequency.value = freq;
      gain.gain.value = vol == null ? 0.2 : vol;
      osc.connect(gain);
      gain.connect(ac.destination);
      osc.start();
      gain.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + duration);
      osc.stop(ac.currentTime + duration + 0.05);
    } catch (_) { /* тихо игнорируем — звук необязателен */ }
  }
  function playKick() { playTone(140, 0.14, "square", 0.22); }
  function playWhistle() { playTone(1700, 0.3, "sine", 0.14); }
  function playSaveThud() { playTone(90, 0.18, "square", 0.28); }
  function playConcede() { playTone(160, 0.35, "sawtooth", 0.18); }
  function playGoalHorn() {
    playTone(320, 0.4, "sawtooth", 0.2);
    setTimeout(() => playTone(520, 0.35, "sawtooth", 0.2), 120);
  }

  // ------------------------- Конфетти (канвас, без картинок) --------------

  let confetti = [];
  function spawnConfetti() {
    const colors = ["#c1272d", "#ffffff", "#ffe27a", "#8f1418"];
    for (let i = 0; i < 36; i++) {
      confetti.push({
        x: W / 2 + (Math.random() - 0.5) * W * 0.5,
        y: H * 0.22,
        vx: (Math.random() - 0.5) * 4.5,
        vy: -Math.random() * 3.5 - 1.5,
        size: 4 + Math.random() * 4,
        color: colors[Math.floor(Math.random() * colors.length)],
        rot: Math.random() * Math.PI * 2,
        vr: (Math.random() - 0.5) * 0.35,
        life: 0,
      });
    }
  }
  function updateAndDrawConfetti() {
    if (!confetti.length) return;
    confetti.forEach((p) => {
      p.vy += 0.12;
      p.x += p.vx;
      p.y += p.vy;
      p.rot += p.vr;
      p.life += 1;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size);
      ctx.restore();
    });
    confetti = confetti.filter((p) => p.life < 90 && p.y < H + 30);
  }

  // ------------------------- Праздничный эффект (идеальный матч/победа) ---
  // Взлетающий герб клуба + вспышка экрана + двойная порция конфетти —
  // отдельно от обычного "гол забит", для по-настоящему крупных побед.

  let logoImg = null; // предзагружается ниже, используется и тут, и в карточке результата
  let celebration = null; // { startTs, duration }

  function spawnBigCelebration() {
    spawnConfetti();
    spawnConfetti();
    celebration = { startTs: performance.now(), duration: 1500 };
  }

  function updateAndDrawCelebration() {
    if (!celebration) return;
    const t = (performance.now() - celebration.startTs) / celebration.duration;
    if (t >= 1) { celebration = null; return; }

    // Вспышка экрана — яркая в начале, быстро гаснет.
    const flash = Math.max(0, 1 - t * 4.5);
    if (flash > 0) {
      ctx.fillStyle = `rgba(255,255,255,${(flash * 0.55).toFixed(3)})`;
      ctx.fillRect(0, 0, W, H);
    }

    // Взлетающий и тающий герб клуба.
    if (logoImg && logoImg.width && logoImg.height) {
      const alpha = Math.max(0, 1 - t);
      const size = 90 + t * 50;
      const w0 = size, h0 = size * (logoImg.height / logoImg.width);
      const y = H * 0.42 - t * H * 0.22;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.drawImage(logoImg, W / 2 - w0 / 2, y - h0 / 2, w0, h0);
      ctx.restore();
    }
  }

  // ------------------------- Достижения ------------------------------------

  let achievementCatalog = [];
  function achievementTitle(id) {
    const a = achievementCatalog.find((x) => x.id === id);
    return a ? a.title : id;
  }

  // ------------------------- Игровое состояние ---------------------------

  const GOAL = { top: 0, bottom: 0, left: 0, right: 0 }; // пересчитывается в layout()
  const SLOTS = ["farLeft", "left", "center", "right", "farRight"];

  let currentUser = null;
  let match = null; // { token, difficulty, shotsPerMatch, mode, opponentName }
  let duelContext = null; // { duelId, token, role } — заполняется, когда играем дуэль, а не обычный матч
  let currentMode = "attack"; // 'attack' | 'defense' — второй режим "Вратарь"
  let shotIndex = 0;
  let successCount = 0;
  let keeperX = 0.5; // 0..1 по ширине ворот
  let keeperDive = null; // {target, startTs, duration}
  let playerDiveSlot = null; // в режиме "Вратарь" — куда тапнул игрок
  let ball = null; // {x,y, targetX, targetY, startTs, duration, resolved, slot, high}
  let charging = false;
  let chargeStart = 0;
  let aimStart = null;
  let aimCurrent = null;
  let lastResult = null; // 'goal' | 'save' | 'miss' | 'playerSave' | 'concede'
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

  function easeOutCubic(t) {
    return 1 - Math.pow(1 - t, 3);
  }

  let kickAnim = null; // { startTs } — короткая анимация "удара ногой" в момент броска

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

    // Вратарь — с наклоном тела и вытянутой рукой в сторону броска (вместо
    // статичного прямоугольника), плюс отдельные позы для сэйва/пропущенного.
    const kx = GOAL.left + keeperX * (GOAL.right - GOAL.left);
    const ky = GOAL.top + (GOAL.bottom - GOAL.top) * 0.55;

    let diveT = 1, diveDir = 0;
    if (keeperDive) {
      diveT = Math.min(1, (performance.now() - keeperDive.startTs) / keeperDive.duration);
      diveDir = keeperDive.to - keeperDive.from;
    }
    const dirSign = diveDir > 0.01 ? 1 : diveDir < -0.01 ? -1 : 0;
    const leanProgress = diveT < 1 ? Math.min(1, diveT * 3) : 0.55; // держит небольшой наклон и после приземления
    const leanAngle = dirSign * 0.4 * leanProgress;
    const isSavePose = lastResult === "save" || lastResult === "playerSave";
    const isConcedePose = lastResult === "goal" || lastResult === "concede";
    const squash = isConcedePose ? 0.82 : 1; // немного "оседает", если пропустил

    ctx.save();
    ctx.translate(kx, ky);
    ctx.rotate(leanAngle);
    ctx.scale(1, squash);

    ctx.fillStyle = "#222";
    ctx.fillRect(-22, -26, 44, 52);
    ctx.fillStyle = "#c1272d";
    ctx.fillRect(-22, -26, 44, 10);
    ctx.fillStyle = "#ffe0b2";
    ctx.beginPath(); ctx.arc(0, -32, 12, 0, Math.PI * 2); ctx.fill();

    ctx.strokeStyle = "#222";
    ctx.lineWidth = 8;
    ctx.lineCap = "round";
    if (isSavePose) {
      // Руки вверх — "взял!"
      ctx.beginPath(); ctx.moveTo(-14, -18); ctx.lineTo(-26, -46); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(14, -18); ctx.lineTo(26, -46); ctx.stroke();
    } else if (keeperDive && !isConcedePose) {
      // Рука тянется в сторону броска, чем дальше в прыжке — тем сильнее вытянута.
      const reach = 18 + 22 * Math.min(1, diveT * 1.6);
      const armY = -20 - 10 * Math.min(1, diveT * 1.6);
      ctx.beginPath(); ctx.moveTo(dirSign * 14, -18); ctx.lineTo(dirSign * reach, armY); ctx.stroke();
    }
    ctx.restore();

    // Игрок/точка удара (низ поля) — в режиме "Вратарь" тут бьёт соперник
    const px = W / 2, py = H * 0.9;
    ctx.fillStyle = currentMode === "defense" ? "#2b3a55" : "#8f1418";
    ctx.beginPath(); ctx.arc(px, py, 10, 0, Math.PI * 2); ctx.fill();

    // Короткий "замах ногой" в момент удара — оживляет статичную точку игрока.
    if (kickAnim) {
      const kt = (performance.now() - kickAnim.startTs) / 260;
      if (kt >= 1) {
        kickAnim = null;
      } else {
        const swing = Math.sin(Math.min(1, kt) * Math.PI);
        ctx.strokeStyle = currentMode === "defense" ? "#2b3a55" : "#8f1418";
        ctx.lineWidth = 6;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(px, py + 6);
        ctx.lineTo(px + swing * 16, py + 6 - swing * 14);
        ctx.stroke();
      }
    }

    ctx.font = "11px sans-serif";
    ctx.textAlign = "center";
    ctx.fillStyle = "#333";
    ctx.fillText(currentMode === "defense" ? "Бьёт соперник" : "Бьёшь ты", px, py + 24);

    // Мяч — с лёгким шлейфом "скорости", вращением и уменьшением по мере
    // удаления к воротам (простое ощущение перспективы без новых картинок).
    if (ball) {
      const t = Math.min(1, (performance.now() - ball.startTs) / ball.duration);
      const ease = easeOutCubic(t);
      const bx = px + (ball.targetX - px) * ease;
      const by = py + (ball.targetY - py) * ease - Math.sin(Math.PI * ease) * (ball.high ? 46 : 14);

      for (let step = 3; step >= 1; step--) {
        const tt = Math.max(0, t - step * 0.05);
        const easeTt = easeOutCubic(tt);
        const tx = px + (ball.targetX - px) * easeTt;
        const ty = py + (ball.targetY - py) * easeTt - Math.sin(Math.PI * easeTt) * (ball.high ? 46 : 14);
        const trailR = Math.max(1.5, 7 * (1 - 0.3 * easeTt) * (1 - step * 0.12));
        ctx.globalAlpha = 0.12 * (4 - step);
        ctx.fillStyle = "#111";
        ctx.beginPath(); ctx.arc(tx, ty, trailR, 0, Math.PI * 2); ctx.fill();
      }
      ctx.globalAlpha = 1;

      const radius = 7 * (1 - 0.3 * ease);
      ctx.save();
      ctx.translate(bx, by);
      ctx.rotate(ease * Math.PI * 5);
      ctx.fillStyle = "#111";
      ctx.beginPath(); ctx.arc(0, 0, radius, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(-radius, 0); ctx.lineTo(radius, 0); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, -radius); ctx.lineTo(0, radius); ctx.stroke();
      ctx.restore();

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
      const labels = {
        goal: { text: "ГОЛ!", color: "#1a7a2e" },
        save: { text: "ВЫШЕ! Вратарь взял", color: "#8f1418" },
        miss: { text: "МИМО", color: "#8f1418" },
        playerSave: { text: "СЭЙВ! 🧤", color: "#1a7a2e" },
        concede: { text: "ГОЛ СОПЕРНИКА", color: "#8f1418" },
      };
      const info = labels[lastResult] || { text: "", color: "#222" };
      ctx.font = "bold 26px sans-serif";
      ctx.textAlign = "center";
      ctx.fillStyle = info.color;
      ctx.fillText(info.text, W / 2, H * 0.7);
    }

    // В режиме "Вратарь" полоска слева показывает, сколько времени осталось на реакцию.
    if (currentMode === "defense" && ball && !ball.resolved) {
      const t = Math.min(1, (performance.now() - ball.startTs) / ball.duration);
      el.powerBar.style.height = `${Math.max(0, (1 - t)) * 100}%`;
    }

    updateAndDrawConfetti();
    updateAndDrawCelebration();

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
      keeperX = keeperDive.from + (keeperDive.to - keeperDive.from) * easeOutCubic(t);
      if (t < 1) requestAnimationFrame(tick);
    };
    tick();
  }

  function resolveShot() {
    ball.resolved = true;
    if (currentMode === "defense") {
      const divedRightZone = playerDiveSlot === ball.slot;
      const saved = divedRightZone && !(ball.high && Math.random() < 0.3);
      if (saved) {
        lastResult = "playerSave";
        successCount += 1;
        playSaveThud();
      } else {
        lastResult = "concede";
        playConcede();
      }
    } else {
      const savedZoneMatches = keeperDive && keeperDive.guessSlot === ball.slot;
      if (ball.tooWeak) {
        lastResult = "miss";
        playKick();
      } else if (savedZoneMatches && !(ball.high && Math.random() < 0.35)) {
        lastResult = "save";
        playWhistle();
      } else {
        lastResult = "goal";
        successCount += 1;
        spawnConfetti();
        playGoalHorn();
      }
    }
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
    playerDiveSlot = null;
    el.powerBar.style.height = "0%";
    shotIndex += 1;
    if (shotIndex >= match.shotsPerMatch) {
      finishMatch();
    } else if (currentMode === "defense") {
      startDefenseRound();
    } else {
      el.footer.textContent = `Удар ${shotIndex + 1} из ${match.shotsPerMatch} — зажми и веди пальцем, отпусти для удара.`;
    }
  }

  // ------------------------- Режим "Вратарь" (защита) ---------------------

  function startDefenseRound() {
    playerDiveSlot = null;
    keeperX = 0.5;
    const diff = match.difficulty;
    const slot = SLOTS[Math.floor(Math.random() * SLOTS.length)];
    const high = Math.random() < Math.min(0.55, 0.12 + diff.level * 0.014);
    const px = W / 2, py = H * 0.9;
    // Окно на реакцию сокращается с уровнем сложности (сложнее = меньше времени тапнуть).
    const duration = Math.max(550, Math.min(1800, diff.reactionMs * 2.6));
    ball = {
      startTs: performance.now(),
      duration,
      targetX: slotToX(slot),
      targetY: GOAL.top + (GOAL.bottom - GOAL.top) * (high ? 0.15 : 0.6),
      high,
      slot,
      tooWeak: false,
      resolved: false,
    };
    el.footer.textContent = `Бросок ${shotIndex + 1} из ${match.shotsPerMatch} — соперник бьёт! Тапни по воротам туда, куда полетит мяч.`;
  }

  function handleDefenseTap(clientX) {
    if (!match || !ball || ball.resolved) return;
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const dx = (x - W / 2) / (W * 0.35);
    const slot = pickSlotFromDx(dx);
    playerDiveSlot = slot;
    keeperDive = {
      from: keeperX,
      to: SLOTS.indexOf(slot) / (SLOTS.length - 1),
      startTs: performance.now(),
      duration: 110,
    };
    const tick = () => {
      if (!keeperDive) return;
      const t = Math.min(1, (performance.now() - keeperDive.startTs) / keeperDive.duration);
      keeperX = keeperDive.from + (keeperDive.to - keeperDive.from) * easeOutCubic(t);
      if (t < 1) requestAnimationFrame(tick);
    };
    tick();
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
    kickAnim = { startTs: performance.now() };
    startKeeperDive(slot, match.difficulty);
  }

  // ------------------------- Управление (pointer) -------------------------

  canvas.addEventListener("pointerdown", (e) => {
    if (!match) return;
    if (currentMode === "defense") {
      handleDefenseTap(e.clientX);
      return;
    }
    if (ball) return;
    charging = true;
    chargeStart = performance.now();
    aimStart = { x: e.clientX, y: e.clientY };
    aimCurrent = { x: e.clientX, y: e.clientY };
  });
  canvas.addEventListener("pointermove", (e) => {
    if (currentMode === "defense" || !charging) return;
    aimCurrent = { x: e.clientX, y: e.clientY };
    const power = Math.min(1, (performance.now() - chargeStart) / 900);
    el.powerBar.style.height = `${power * 100}%`;
  });
  function release(e) {
    if (currentMode === "defense" || !charging) return;
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

  function showOverlay({
    title, text, btnLabel, btn2Label, btn3Label, btn4Label, btn5Label, btn6Label,
    onBtn, onBtn2, onBtn3, onBtn4, onBtn5, onBtn6, renderList,
  }) {
    el.overlay.classList.remove("hidden");
    el.overlayTitle.textContent = title;
    el.overlayText.textContent = text || "";
    el.overlayList.innerHTML = "";
    if (renderList) {
      el.overlayList.style.display = "flex";
      renderList(el.overlayList);
    } else {
      el.overlayList.style.display = "none";
    }
    el.overlayBtn.style.display = btnLabel ? "inline-block" : "none";
    el.overlayBtn.textContent = btnLabel || "";
    el.overlayBtn.onclick = onBtn || null;
    el.overlayBtn2.style.display = btn2Label ? "inline-block" : "none";
    el.overlayBtn2.textContent = btn2Label || "";
    el.overlayBtn2.onclick = onBtn2 || null;
    el.overlayBtn3.style.display = btn3Label ? "inline-block" : "none";
    el.overlayBtn3.textContent = btn3Label || "";
    el.overlayBtn3.onclick = onBtn3 || null;
    el.overlayBtn4.style.display = btn4Label ? "inline-block" : "none";
    el.overlayBtn4.textContent = btn4Label || "";
    el.overlayBtn4.onclick = onBtn4 || null;
    el.overlayBtn5.style.display = btn5Label ? "inline-block" : "none";
    el.overlayBtn5.textContent = btn5Label || "";
    el.overlayBtn5.onclick = onBtn5 || null;
    el.overlayBtn6.style.display = btn6Label ? "inline-block" : "none";
    el.overlayBtn6.textContent = btn6Label || "";
    el.overlayBtn6.onclick = onBtn6 || null;
  }
  function hideOverlay() { el.overlay.classList.add("hidden"); }

  // ------------------------- Аватарки / бейджи команд (без картинок) -------

  const BADGE_COLORS = ["#c1272d", "#2b3a55", "#1a7a2e", "#7a5c1a", "#5a3d7a", "#8f1418", "#0e6e6e"];
  function colorForText(text) {
    let hash = 0;
    for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
    return BADGE_COLORS[hash % BADGE_COLORS.length];
  }
  function initialsFor(name) {
    const clean = (name || "").replace(/[«»"()0-9-]/g, " ").trim();
    const words = clean.split(/\s+/).filter(Boolean);
    if (!words.length) return "??";
    if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
    return (words[0][0] + words[1][0]).toUpperCase();
  }
  function makeAvatarFallback(name) {
    const div = document.createElement("div");
    div.className = "lb-avatar lb-avatar-fallback";
    div.style.background = colorForText(name || "?");
    div.textContent = initialsFor(name);
    return div;
  }
  function makeAvatarEl(name, photoUrl) {
    if (!photoUrl) return makeAvatarFallback(name);
    const img = document.createElement("img");
    img.className = "lb-avatar";
    img.src = photoUrl;
    img.alt = "";
    img.referrerPolicy = "no-referrer";
    img.onerror = () => { img.replaceWith(makeAvatarFallback(name)); };
    return img;
  }

  function renderLeaderboardRows(container, rows) {
    if (!rows.length) return;
    rows.forEach((r, i) => {
      const row = document.createElement("div");
      row.className = "lb-row";
      const rank = document.createElement("span");
      rank.className = "lb-rank";
      rank.textContent = `${i + 1}.`;
      const name = document.createElement("span");
      name.className = "lb-name";
      name.textContent = r.name;
      const score = document.createElement("span");
      score.className = "lb-score";
      score.textContent = r.score;
      row.append(rank, makeAvatarEl(r.name, r.photoUrl), name, score);
      container.appendChild(row);
    });
  }

  function renderRoadRows(container, rows) {
    rows.forEach((r) => {
      const row = document.createElement("div");
      row.className = `lb-row road-row road-${r.status}`;
      const badge = makeAvatarFallback(r.name);
      const name = document.createElement("span");
      name.className = "lb-name";
      name.textContent = `${r.level}. ${r.name}`;
      const status = document.createElement("span");
      status.className = "lb-score";
      status.textContent = r.status === "done" ? "✅" : r.status === "current" ? "▶️" : "⏳";
      row.append(badge, name, status);
      container.appendChild(row);
    });
  }

  function showAchievements() {
    const earned = new Set((currentUser && currentUser.achievements) || []);
    const lines = achievementCatalog.length
      ? achievementCatalog
          .map((a) => `${earned.has(a.id) ? "✅" : "▫️"} ${a.title} — ${a.desc}`)
          .join("\n")
      : "Список достижений пока не загружен.";
    showOverlay({
      title: "🏅 Достижения",
      text: lines,
      btnLabel: "Назад",
      onBtn: renderHome,
    });
  }

  async function showLeaderboard() {
    const board = await fetch("/api/leaderboard").then((r) => r.json());
    const rows = board.week.slice(0, 10);
    showOverlay({
      title: "🏆 Топ недели",
      text: rows.length ? "" : "Пока пусто — стань первым!",
      renderList: rows.length ? (container) => renderLeaderboardRows(container, rows) : null,
      btnLabel: "Назад",
      onBtn: () => renderHome(),
    });
  }

  function showOpponentMap() {
    if (!currentUser) return;
    const rows = Array.isArray(currentUser.opponentRoad) ? currentUser.opponentRoad : [];
    showOverlay({
      title: "🗺️ Карта соперников",
      text: rows.length ? "" : "Карта пока недоступна.",
      renderList: rows.length ? (container) => renderRoadRows(container, rows) : null,
      btnLabel: "Назад",
      onBtn: renderHome,
    });
  }

  const SOCIAL_BONUS_KINDS = [
    { kind: "news", label: "📰 Новость клуба" },
    { kind: "vk", label: "🔵 ВКонтакте клуба" },
    { kind: "max", label: "🟠 MAX клуба" },
  ];

  async function claimSocialBonus(kind) {
    try {
      const res = await api(`/api/bonus/${kind}`, {});
      currentUser = res;
      updateHudFromState(currentUser);
      const url = currentUser[`${kind}Url`];
      if (url && tg && tg.openLink) {
        tg.openLink(url);
      } else if (url) {
        window.open(url, "_blank");
      }
    } catch (err) {
      /* если бонус не настроен или уже забран — просто останемся на этом экране */
    }
    showBonuses();
  }

  function hasAnySocialLink() {
    return SOCIAL_BONUS_KINDS.some((k) => currentUser && currentUser[`${k.kind}Url`]);
  }

  function showBonuses() {
    if (!currentUser) return;
    const configured = SOCIAL_BONUS_KINDS.filter((k) => currentUser[`${k.kind}Url`]);
    if (!configured.length) {
      showOverlay({ title: "🎁 Бонусы", text: "Пока не настроено ни одной ссылки.", btnLabel: "Назад", onBtn: renderHome });
      return;
    }
    const lines = configured
      .map((k) => `${currentUser[`${k.kind}BonusAvailable`] ? "🟢" : "⚪️"} ${k.label} — ${currentUser[`${k.kind}BonusAvailable`] ? "доступно, +2 попытки" : "уже забрано сегодня"}`)
      .join("\n");
    const claimable = configured.filter((k) => currentUser[`${k.kind}BonusAvailable`]);
    showOverlay({
      title: "🎁 Бонусы за подписки",
      text: `Переходи по ссылкам клуба — за первый переход в день даём +2 попытки сверх обычного максимума.\n\n${lines}`,
      btnLabel: claimable[0] ? claimable[0].label : undefined,
      onBtn: claimable[0] ? () => claimSocialBonus(claimable[0].kind) : undefined,
      btn2Label: claimable[1] ? claimable[1].label : undefined,
      onBtn2: claimable[1] ? () => claimSocialBonus(claimable[1].kind) : undefined,
      btn3Label: claimable[2] ? claimable[2].label : undefined,
      onBtn3: claimable[2] ? () => claimSocialBonus(claimable[2].kind) : undefined,
      btn4Label: "Назад",
      onBtn4: renderHome,
    });
  }

  function renderHome() {
    if (!currentUser) return;
    const anyBonusAvailable = SOCIAL_BONUS_KINDS.some((k) => currentUser[`${k.kind}BonusAvailable`]);
    const bonusBtn = hasAnySocialLink() ? (anyBonusAvailable ? "🎁 Бонусы (есть!)" : "🎁 Бонусы") : null;
    const isDefense = currentUser.mode === "defense";
    const modeIcon = isDefense ? "🧤" : "⚽";
    const opponent = currentUser.opponentName || `Соперник №${currentUser.level}`;
    const actionVerb = isDefense ? "Отражай броски" : "Забивай голы";
    const tierName = (currentUser.difficulty && currentUser.difficulty.tier) || null;
    const tierSuffix = tierName ? ` Сложность: ${tierName}.` : "";
    const goalPhrase = isDefense
      ? `Отрази все ${currentUser.shotsPerMatch} бросков — пройдёшь дальше!${tierSuffix}`
      : `Забей все ${currentUser.shotsPerMatch} — откроешь следующего соперника!${tierSuffix}`;

    if (!currentUser.matchDayActive && currentUser.energy < 1) {
      showOverlay({
        title: "Энергия закончилась",
        text: `Следующая попытка через ${fmtMs(currentUser.msUntilNextEnergy)}. Заходи завтра — получишь бонус за стрик!` +
          (anyBonusAvailable ? " А пока можно забрать бонусы за подписки клуба." : ""),
        btn2Label: "Таблица лидеров",
        onBtn2: showLeaderboard,
        btn3Label: bonusBtn,
        onBtn3: showBonuses,
        btn4Label: "🏅 Достижения",
        onBtn4: showAchievements,
        btn5Label: "⚔️ Вызвать на дуэль",
        onBtn5: startDuelChallenge,
        btn6Label: "🗺️ Карта соперников",
        onBtn6: showOpponentMap,
      });
      return;
    }
    showOverlay({
      title: currentUser.matchDayActive ? `⚡ День матча — попытки безлимитны!` : `${modeIcon} ${opponent}`,
      text: currentUser.matchDayActive
        ? `Сегодня день игры клуба — ${actionVerb.toLowerCase()} сколько хочешь! Соперник: ${opponent}.`
        : `У тебя ${currentUser.energy} попыток. ${goalPhrase}`,
      btnLabel: "Играть",
      btn2Label: "Таблица лидеров",
      onBtn: startMatchFlow,
      onBtn2: showLeaderboard,
      btn3Label: bonusBtn,
      onBtn3: showBonuses,
      btn4Label: "🏅 Достижения",
      onBtn4: showAchievements,
      btn5Label: "⚔️ Вызвать на дуэль",
      onBtn5: startDuelChallenge,
      btn6Label: "🗺️ Карта соперников",
      onBtn6: showOpponentMap,
    });
  }

  async function startMatchFlow() {
    try {
      const res = await api("/api/match/start", {});
      match = res;
      currentMode = res.mode || "attack";
      shotIndex = 0;
      successCount = 0;
      keeperX = 0.5;
      keeperDive = null;
      playerDiveSlot = null;
      ball = null;
      hideOverlay();
      if (currentMode === "defense") {
        startDefenseRound();
      } else {
        el.footer.textContent = `Удар 1 из ${match.shotsPerMatch} — зажми и веди пальцем, отпусти для удара.`;
      }
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

  let lastPlayedMode = "attack";
  async function finishMatch() {
    if (duelContext) {
      return finishDuelMatch();
    }
    const playedMode = currentMode;
    lastPlayedMode = playedMode;
    try {
      const res = await api("/api/match/result", { token: match.token, goals: successCount });
      currentUser = res;
      updateHudFromState(currentUser);
      const perfect = res.perfect;
      const isDefense = playedMode === "defense";
      const verbPast = isDefense ? "Отражено" : "Забито";
      let title = perfect
        ? (isDefense ? "Ни одного гола не пропущено! 🧤🎉" : "Идеальный матч! 🎉")
        : `${verbPast} ${successCount} из ${match.shotsPerMatch}`;
      let text = perfect
        ? `Следующий соперник: ${res.opponentName || ("№" + res.level)}. Расскажи друзьям в чате клуба!`
        : (isDefense
            ? `Попробуй отразить все ${match.shotsPerMatch} бросков — это пропустит тебя дальше.`
            : `Попробуй выбить все ${match.shotsPerMatch} — это откроет следующего соперника.`);

      if (res.tierChanged && res.tierName) {
        text += `\n\n🎖️ Новый уровень сложности: ${res.tierName}!`;
      }
      if (res.newAchievements && res.newAchievements.length) {
        const names = res.newAchievements.map(achievementTitle).join(", ");
        text += `\n\n🏅 Новое достижение: ${names}!`;
      }

      if (perfect) {
        spawnBigCelebration();
      }

      showOverlay({
        title,
        text,
        btnLabel: (currentUser.matchDayActive || currentUser.energy >= 1) ? "Играть ещё" : undefined,
        btn2Label: "Поделиться результатом",
        btn3Label: "🏅 Достижения",
        onBtn: startMatchFlow,
        onBtn2: shareResult,
        onBtn3: showAchievements,
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

  // ------------------------------- Дуэли ---------------------------------

  async function startDuelChallenge() {
    try {
      const res = await api("/api/duel/create", {});
      const shareText =
        `⚔️ Вызываю тебя на дуэль в «Забей гол» — ХК «Знамя-Удмуртия»! ` +
        `${res.shotsPerDuel} ударов, у обоих одинаковый вратарь — честная игра.`;
      if (res.shareUrl) {
        if (tg && tg.openTelegramLink) {
          const url = `https://t.me/share/url?url=${encodeURIComponent(res.shareUrl)}&text=${encodeURIComponent(shareText)}`;
          tg.openTelegramLink(url);
        } else {
          window.prompt("Скопируй и отправь другу:", `${shareText}\n${res.shareUrl}`);
        }
      }
      showOverlay({
        title: "⚔️ Дуэль создана!",
        text:
          `Ссылка отправлена (или скопирована) — перешли её другу, чтобы он принял вызов. ` +
          `А пока сыграй свою попытку: ${res.shotsPerDuel} ударов против вратаря уровня «${res.difficulty.tier}».`,
        btnLabel: "Играть свою попытку",
        onBtn: () => startDuelMatchFlow(res.duelId),
        btn2Label: "Назад",
        onBtn2: renderHome,
      });
    } catch (err) {
      showOverlay({ title: "Не получилось", text: "Не удалось создать дуэль, попробуй ещё раз.", btnLabel: "Ок", onBtn: renderHome });
    }
  }

  async function startDuelMatchFlow(duelId) {
    try {
      const res = await api("/api/duel/start", { duelId });
      duelContext = { duelId, token: res.token, role: res.role };
      match = { token: res.token, shotsPerMatch: res.shotsPerDuel, difficulty: res.difficulty, mode: "attack" };
      currentMode = "attack";
      shotIndex = 0;
      successCount = 0;
      keeperX = 0.5;
      keeperDive = null;
      playerDiveSlot = null;
      ball = null;
      hideOverlay();
      el.footer.textContent = `Дуэль! Удар 1 из ${match.shotsPerMatch} — зажми и веди пальцем, отпусти для удара.`;
    } catch (err) {
      const code = err.payload && err.payload.error;
      const text =
        code === "ALREADY_PLAYED"
          ? "Ты уже сыграл свою попытку в этой дуэли — жди результата, он придёт в чат бота, как только сыграет соперник."
          : code === "DUEL_FULL"
          ? "В этой дуэли уже играют два других болельщика."
          : "Не получилось начать дуэль, попробуй ещё раз.";
      showOverlay({ title: "⚔️ Дуэль", text, btnLabel: "На главный экран", onBtn: renderHome });
    }
  }

  async function finishDuelMatch() {
    const ctx = duelContext;
    try {
      const res = await api("/api/duel/result", { duelId: ctx.duelId, token: ctx.token, goals: successCount });
      let title, text;
      if (res.finished) {
        if (res.winner === "draw") {
          title = "🤝 Ничья!";
          spawnConfetti();
        } else {
          const iWon = res.winner === res.role;
          title = iWon ? "🏆 Победа в дуэли!" : "Поражение в дуэли";
          if (iWon) spawnBigCelebration();
        }
        text = `${res.creatorName}: ${res.creatorGoals} — ${res.opponentName}: ${res.opponentGoals}`;
      } else {
        title = "Попытка засчитана!";
        text = `Ты выбил ${successCount} из ${match.shotsPerMatch}. Ждём, пока сыграет соперник — результат придёт в чат бота.`;
      }
      if (res.finished) {
        showOverlay({
          title,
          text,
          btnLabel: "На главный экран",
          onBtn: renderHome,
          btn2Label: "Поделиться результатом",
          onBtn2: () => shareDuelResult(res),
        });
      } else {
        showOverlay({ title, text, btnLabel: "На главный экран", onBtn: renderHome });
      }
    } catch (err) {
      showOverlay({ title: "Ошибка", text: "Не удалось сохранить результат дуэли.", btnLabel: "Ок", onBtn: renderHome });
    } finally {
      duelContext = null;
      match = null;
    }
  }

  async function renderDuelInvite(duelId) {
    try {
      const info = await api("/api/duel/info", { duelId });
      if (info.role === "spectator") {
        const text = info.finished
          ? `${info.creatorName}: ${info.creatorGoals} — ${info.opponentName}: ${info.opponentGoals}`
          : "В этой дуэли уже играют два других болельщика.";
        showOverlay({ title: "⚔️ Дуэль занята", text, btnLabel: "На главный экран", onBtn: renderHome });
        return;
      }
      if (info.alreadyPlayed) {
        const text = info.finished
          ? `${info.creatorName}: ${info.creatorGoals} — ${info.opponentName}: ${info.opponentGoals}`
          : "Ты уже сыграл свою попытку — ждём соперника, результат придёт в чат бота.";
        showOverlay({
          title: info.finished ? "⚔️ Дуэль завершена" : "⚔️ Дуэль",
          text,
          btnLabel: "На главный экран",
          onBtn: renderHome,
        });
        return;
      }
      showOverlay({
        title: "⚔️ Вызов на дуэль!",
        text: `${info.creatorName} вызывает тебя на дуэль: ${info.shotsPerDuel} ударов, вратарь уровня «${info.difficulty.tier}». Готов?`,
        btnLabel: "Принять вызов",
        onBtn: () => startDuelMatchFlow(duelId),
        btn2Label: "На главный экран",
        onBtn2: renderHome,
      });
    } catch (err) {
      showOverlay({ title: "Дуэль не найдена", text: "Ссылка устарела или недействительна.", btnLabel: "На главный экран", onBtn: renderHome });
    }
  }

  // ------------------------- Карточка результата для шеринга ---------------

  let logoImagePromise = null;
  function loadLogoImage() {
    if (!logoImagePromise) {
      logoImagePromise = new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => resolve(null);
        img.src = "assets/logo.png";
      });
    }
    return logoImagePromise;
  }

  /** Путь скруглённого прямоугольника — без опоры на ctx.roundRect (не везде поддержан). */
  function roundedRectPath(c, x, y, w, h, r) {
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }

  async function buildShareCardBlob({ scoreLine, subtitle, footer }) {
    const w = 1080, h = 1350;
    const cnv = document.createElement("canvas");
    cnv.width = w;
    cnv.height = h;
    const c = cnv.getContext("2d");

    // Фон — сплошной градиент клубных цветов на весь холст (без "обрыва" на пустой белый низ).
    const grad = c.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, "#6f0f12");
    grad.addColorStop(1, "#a81f24");
    c.fillStyle = grad;
    c.fillRect(0, 0, w, h);

    const logo = await loadLogoImage();
    if (logo && logo.width && logo.height) {
      const logoH = 190;
      const logoW = logo.width * (logoH / logo.height);
      c.drawImage(logo, w / 2 - logoW / 2, 70, logoW, logoH);
    }

    c.textAlign = "center";
    c.fillStyle = "#ffffff";
    c.font = "bold 44px sans-serif";
    c.fillText("«Забей гол»", w / 2, 330);
    c.font = "500 30px sans-serif";
    c.fillStyle = "rgba(255,255,255,0.85)";
    c.fillText("ХК «Знамя-Удмуртия»", w / 2, 372);

    // Светлая карточка-панель со счётом — занимает основную часть холста, без пустот.
    const panelX = 90, panelY = 440, panelW = w - 180, panelH = 470;
    roundedRectPath(c, panelX, panelY, panelW, panelH, 36);
    c.fillStyle = "#eef3f7";
    c.fill();

    c.fillStyle = "#8f1418";
    c.font = "bold 140px sans-serif";
    c.fillText(scoreLine, w / 2, panelY + 250);

    c.font = "600 40px sans-serif";
    c.fillStyle = "#5a5f66";
    c.fillText(subtitle, w / 2, panelY + 340);

    // Декоративная полоса клубных цветов под панелью.
    const stripeY = panelY + panelH + 60;
    const stripeCount = 9, stripeW = 40, stripeGap = 14;
    const stripesTotalW = stripeCount * stripeW + (stripeCount - 1) * stripeGap;
    let stripeX = w / 2 - stripesTotalW / 2;
    for (let i = 0; i < stripeCount; i++) {
      c.fillStyle = i % 2 === 0 ? "#ffffff" : "#ffe27a";
      c.fillRect(stripeX, stripeY, stripeW, 10);
      stripeX += stripeW + stripeGap;
    }

    c.font = "bold 42px sans-serif";
    c.fillStyle = "#ffffff";
    c.fillText(footer || "Заходи сыграть в Telegram", w / 2, stripeY + 100);

    c.font = "500 28px sans-serif";
    c.fillStyle = "rgba(255,255,255,0.75)";
    c.fillText("Официальная игра ХК «Знамя-Удмуртия»", w / 2, h - 70);

    return new Promise((resolve) => cnv.toBlob((blob) => resolve(blob), "image/png"));
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  /** Пытается поделиться картинкой (нативный шаринг файла, иначе — через ссылку на сервере). Возвращает true, если получилось. */
  async function shareCardImage(blob, textCaption) {
    if (!blob) return false;
    try {
      const file = new File([blob], "goal-game-result.png", { type: "image/png" });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: "«Забей гол»", text: textCaption });
        return true;
      }
    } catch (_) {
      /* пользователь отменил или платформа не поддерживает шаринг файлов — пробуем запасной вариант */
    }
    try {
      const dataUrl = await blobToDataUrl(blob);
      const res = await api("/api/share-card", { imageBase64: dataUrl });
      if (res.url) {
        if (tg && tg.shareToStory) {
          tg.shareToStory(res.url, { text: textCaption });
          return true;
        }
        if (tg && tg.openLink) {
          tg.openLink(res.url);
        } else {
          window.open(res.url, "_blank");
        }
        return true;
      }
    } catch (_) {
      /* не получилось — упадём в текстовый шаринг ниже */
    }
    return false;
  }

  async function shareResult() {
    const verb = lastPlayedMode === "defense" ? "Отразил" : "Забил";
    const text = `${verb} ${successCount} из ${match ? match.shotsPerMatch : 5} в игре «Забей гол» ХК «Знамя-Удмуртия» 🔴⚪ Стрик: ${currentUser.streak} дней. Заходи сыграть!`;

    try {
      const scoreLine = `${successCount}/${match ? match.shotsPerMatch : 5}`;
      const subtitle = lastPlayedMode === "defense" ? "отражено в режиме «Вратарь»" : "голов забито вратарю";
      const blob = await buildShareCardBlob({ scoreLine, subtitle, footer: "Заходи сыграть — «Забей гол»" });
      if (await shareCardImage(blob, text)) return;
    } catch (_) {
      /* если с картинкой не вышло — делимся обычным текстом ниже */
    }

    const botUrl = (currentUser && currentUser.botUrl) || "";
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

  async function shareDuelResult(res) {
    const subtitle =
      res.winner === "draw" ? "Ничья в дуэли!" : `Победил ${res.winner === "creator" ? res.creatorName : res.opponentName}`;
    const text = `⚔️ Дуэль в «Забей гол»: ${res.creatorName} — ${res.creatorGoals}, ${res.opponentName} — ${res.opponentGoals}. ${subtitle}`;
    try {
      const scoreLine = `${res.creatorGoals} : ${res.opponentGoals}`;
      const blob = await buildShareCardBlob({ scoreLine, subtitle, footer: "⚔️ Вызови друга на дуэль!" });
      if (await shareCardImage(blob, text)) return;
    } catch (_) {
      /* не вышло с картинкой — делимся текстом */
    }
    if (navigator.share) {
      navigator.share({ text }).catch(() => {});
    } else {
      window.prompt("Скопируй и отправь друзьям:", text);
    }
  }

  // ------------------------------- Запуск -------------------------------

  async function init() {
    layout();
    // Заранее подгружаем герб клуба — нужен и для праздничного эффекта на
    // канвасе, и для карточки результата (см. loadLogoImage() ниже).
    loadLogoImage().then((img) => { logoImg = img; });
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
      currentMode = state.mode || "attack";
      if (Array.isArray(state.achievementCatalog)) {
        achievementCatalog = state.achievementCatalog;
      }
      updateHudFromState(state);

      const params = new URLSearchParams(location.search);
      const duelId = params.get("duel");
      if (duelId) {
        await renderDuelInvite(duelId);
      } else {
        renderHome();
      }
    } catch (err) {
      showOverlay({ title: "Не удалось подключиться", text: "Попробуй перезайти в игру через кнопку бота.", });
    }
  }

  window.addEventListener("load", () => { layout(); init(); });
})();
