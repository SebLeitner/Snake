(() => {
  "use strict";

  const canvas = document.querySelector("#game-canvas");
  if (!canvas) return;

  const context = canvas.getContext("2d", { alpha: false });
  const ui = {
    overlay: document.querySelector("#game-overlay"),
    overlayTitle: document.querySelector("#overlay-title"),
    overlayCopy: document.querySelector("#overlay-copy"),
    overlayAction: document.querySelector("#overlay-action"),
    score: document.querySelector("#score"),
    best: document.querySelector("#best-score"),
    level: document.querySelector("#level-value"),
    status: document.querySelector("#game-status"),
    indicator: document.querySelector("#lcd-indicator"),
    start: document.querySelector("#start-button"),
    pause: document.querySelector("#pause-button"),
    sound: document.querySelector("#sound-toggle"),
    levelSelect: document.querySelector("#level-select"),
    resetBest: document.querySelector("#reset-best"),
    screen: document.querySelector("#lcd-screen"),
  };

  if (!context) {
    if (ui.overlayTitle) ui.overlayTitle.textContent = "Display nicht verfügbar";
    if (ui.overlayCopy) ui.overlayCopy.textContent = "Bitte öffne das Spiel in einem aktuellen Browser.";
    for (const control of [ui.overlayAction, ui.start, ui.pause]) {
      if (control) control.disabled = true;
    }
    return;
  }

  const COLUMNS = 24;
  const ROWS = 18;
  const STORAGE_KEY = "rootpilot.snake.v1";
  const STEP_TIMES = [185, 162, 144, 128, 113, 99, 86, 74, 63];
  const DIRECTIONS = Object.freeze({
    up: { x: 0, y: -1 },
    down: { x: 0, y: 1 },
    left: { x: -1, y: 0 },
    right: { x: 1, y: 0 },
  });
  const KEY_DIRECTIONS = {
    ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right",
  };

  const preferences = readPreferences();
  let bestScore = preferences.best;
  let selectedLevel = preferences.level;
  let soundEnabled = preferences.sound;
  let state = "ready";
  let score = 0;
  let snake = [];
  let food = null;
  let direction = DIRECTIONS.right;
  let directionQueue = [];
  let frame = null;
  let lastFrameTime = null;
  let elapsedTime = 0;
  let won = false;
  let pauseReason = "";
  let audioContext = null;
  let resizeFrame = null;
  let colors = { background: "#a7b879", ink: "#27351e" };

  function readPreferences() {
    const defaults = { best: 0, level: 3, sound: false };
    try {
      const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY));
      if (!saved || typeof saved !== "object") return defaults;
      return {
        best: Number.isSafeInteger(saved.best) && saved.best >= 0 ? saved.best : 0,
        level: Number.isInteger(saved.level) && saved.level >= 1 && saved.level <= 9 ? saved.level : 3,
        sound: saved.sound === true,
      };
    } catch {
      // Private browsing and blocked storage must never prevent a game.
      return defaults;
    }
  }

  function savePreferences() {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
        best: bestScore,
        level: selectedLevel,
        sound: soundEnabled,
      }));
    } catch {
      // The current session still works when persistent storage is unavailable.
    }
  }

  function setText(element, value) {
    if (element) element.textContent = value;
  }

  function setButtonText(element, value) {
    if (!element) return;
    const label = element.querySelector("[data-button-label]");
    setText(label || element, value);
  }

  function updateUI() {
    const active = state === "running" || state === "paused";
    const statusLabels = { ready: "Bereit", running: "Läuft", paused: "Pause", over: won ? "Geschafft!" : "Game over" };
    setText(ui.score, String(score).padStart(4, "0"));
    setText(ui.best, String(bestScore).padStart(4, "0"));
    setText(ui.level, String(selectedLevel).padStart(2, "0"));
    setText(ui.status, statusLabels[state]);
    canvas.setAttribute("aria-label", `Snake-Spielfeld: ${statusLabels[state]}. ${score} Punkte. Level ${selectedLevel}.`);

    if (ui.screen) ui.screen.dataset.state = state;
    if (ui.indicator) {
      ui.indicator.dataset.state = state;
      ui.indicator.classList.toggle("is-active", state === "running");
    }
    if (ui.levelSelect) {
      ui.levelSelect.value = String(selectedLevel);
      ui.levelSelect.disabled = active;
    }
    if (ui.resetBest) ui.resetBest.disabled = active || bestScore === 0;
    if (ui.pause) {
      ui.pause.disabled = !active;
      setButtonText(ui.pause, state === "paused" ? "Weiter" : "Pause");
      ui.pause.setAttribute("aria-label", state === "paused" ? "Spiel fortsetzen" : "Spiel pausieren");
    }
    setButtonText(ui.start, active ? "Neu starten" : state === "over" ? "Erneut spielen" : "Spiel starten");
    if (ui.sound) {
      ui.sound.setAttribute("aria-pressed", String(soundEnabled));
      ui.sound.setAttribute("aria-label", soundEnabled ? "Spielton ausschalten" : "Spielton einschalten");
      setButtonText(ui.sound, soundEnabled ? "Ton an" : "Ton aus");
    }

    if (!ui.overlay) return;
    ui.overlay.dataset.state = state;
    ui.overlay.classList.toggle("hidden", state === "running");
    ui.overlay.setAttribute("aria-hidden", String(state === "running"));
    if (ui.overlayAction) ui.overlayAction.tabIndex = state === "running" ? -1 : 0;

    if (state === "ready") {
      setText(ui.overlayTitle, "Bereit?");
      setText(ui.overlayCopy, "Sammle Punkte und vermeide Kollisionen.");
      setButtonText(ui.overlayAction, "Spiel starten");
    } else if (state === "paused") {
      setText(ui.overlayTitle, "Pause");
      setText(ui.overlayCopy, pauseReason === "hidden" ? "Die Runde wurde automatisch pausiert." : "Setze die Runde fort, sobald du bereit bist.");
      setButtonText(ui.overlayAction, "Weiterspielen");
    } else if (state === "over") {
      setText(ui.overlayTitle, won ? "Geschafft!" : "Game over.");
      setText(ui.overlayCopy, won ? `${score} Punkte. Du hast das Spielfeld vollständig gefüllt.` : `${score} Punkte. Starte eine neue Runde.`);
      setButtonText(ui.overlayAction, "Erneut spielen");
    }
  }

  function resetBoard() {
    const centerX = Math.floor(COLUMNS / 2);
    const centerY = Math.floor(ROWS / 2);
    snake = Array.from({ length: 5 }, (_, index) => ({ x: centerX - index, y: centerY }));
    direction = DIRECTIONS.right;
    directionQueue = [];
    score = 0;
    elapsedTime = 0;
    lastFrameTime = null;
    won = false;
    food = chooseFood();
  }

  function chooseFood() {
    const occupied = new Set(snake.map(segment => segment.y * COLUMNS + segment.x));
    const freeCells = COLUMNS * ROWS - occupied.size;
    if (freeCells === 0) return null;
    let chosen = Math.floor(Math.random() * freeCells);
    for (let y = 0; y < ROWS; y += 1) {
      for (let x = 0; x < COLUMNS; x += 1) {
        if (occupied.has(y * COLUMNS + x)) continue;
        if (chosen === 0) return { x, y };
        chosen -= 1;
      }
    }
    return null;
  }

  function stopFrames() {
    if (frame !== null) window.cancelAnimationFrame(frame);
    frame = null;
    lastFrameTime = null;
  }

  function startGame() {
    if (document.hidden) return;
    stopFrames();
    resetBoard();
    state = "running";
    prepareAudio();
    updateUI();
    draw();
    canvas.focus({ preventScroll: true });
    frame = window.requestAnimationFrame(animate);
  }

  function pauseGame(reason = "manual") {
    if (state !== "running") return;
    state = "paused";
    pauseReason = reason;
    directionQueue = [];
    stopFrames();
    updateUI();
  }

  function resumeGame() {
    if (state !== "paused" || document.hidden) return;
    state = "running";
    prepareAudio();
    // Give a full movement interval after resuming, even mid-step.
    elapsedTime = 0;
    lastFrameTime = null;
    updateUI();
    canvas.focus({ preventScroll: true });
    frame = window.requestAnimationFrame(animate);
  }

  function finishGame(victory = false) {
    won = victory;
    state = "over";
    stopFrames();
    directionQueue = [];
    savePreferences();
    updateUI();
    if (victory) {
      playTone(660, 0.09);
      playTone(880, 0.13, 0.12);
    } else {
      playTone(170, 0.12);
      playTone(95, 0.2, 0.13);
    }
  }

  function queueDirection(name) {
    if (state !== "running" || directionQueue.length >= 2) return;
    const next = DIRECTIONS[name];
    if (!next) return;
    const previous = directionQueue.length ? directionQueue[directionQueue.length - 1] : direction;
    if (next.x === previous.x && next.y === previous.y) return;
    if (next.x === -previous.x && next.y === -previous.y) return;
    directionQueue.push(next);
  }

  function advance() {
    if (directionQueue.length) direction = directionQueue.shift();
    const head = { x: snake[0].x + direction.x, y: snake[0].y + direction.y };
    const eating = food !== null && head.x === food.x && head.y === food.y;
    // On a normal step the tail vacates its cell before the head enters it.
    const occupiedLength = snake.length - (eating ? 0 : 1);
    const hitBody = snake.slice(0, occupiedLength).some(segment => segment.x === head.x && segment.y === head.y);
    if (head.x < 0 || head.x >= COLUMNS || head.y < 0 || head.y >= ROWS || hitBody) {
      finishGame();
      return;
    }

    snake.unshift(head);
    if (!eating) {
      snake.pop();
      return;
    }

    score += 10;
    if (score > bestScore) {
      bestScore = score;
      savePreferences();
    }
    food = chooseFood();
    if (food === null) finishGame(true);
    else {
      playTone(740, 0.055);
      updateUI();
    }
  }

  function animate(timestamp) {
    if (state !== "running") return;
    if (lastFrameTime === null) lastFrameTime = timestamp;
    // Background tabs and stalled devices never trigger an instant catch-up death.
    elapsedTime += Math.min(timestamp - lastFrameTime, 250);
    lastFrameTime = timestamp;
    const stepTime = STEP_TIMES[selectedLevel - 1];
    let changed = false;
    while (elapsedTime >= stepTime && state === "running") {
      elapsedTime -= stepTime;
      advance();
      changed = true;
    }
    if (changed) draw();
    if (state === "running") frame = window.requestAnimationFrame(animate);
  }

  function cellRect(x, y, inset = 0.1, size = 0.8) {
    const cellWidth = canvas.width / COLUMNS;
    const cellHeight = canvas.height / ROWS;
    const left = Math.round((x + inset) * cellWidth);
    const top = Math.round((y + inset) * cellHeight);
    const right = Math.round((x + inset + size) * cellWidth);
    const bottom = Math.round((y + inset + size) * cellHeight);
    context.fillRect(left, top, Math.max(1, right - left), Math.max(1, bottom - top));
  }

  function pixelRect(x, y, offsetX, offsetY, width, height) {
    const cellWidth = canvas.width / COLUMNS;
    const cellHeight = canvas.height / ROWS;
    const left = Math.round((x + offsetX) * cellWidth);
    const top = Math.round((y + offsetY) * cellHeight);
    const right = Math.round((x + offsetX + width) * cellWidth);
    const bottom = Math.round((y + offsetY + height) * cellHeight);
    context.fillRect(left, top, Math.max(1, right - left), Math.max(1, bottom - top));
  }

  function draw() {
    context.imageSmoothingEnabled = false;
    context.fillStyle = colors.background;
    context.fillRect(0, 0, canvas.width, canvas.height);

    // A very faint cell texture keeps the monochrome LCD readable at any size.
    context.fillStyle = colors.ink;
    context.globalAlpha = 0.035;
    for (let y = 0; y < ROWS; y += 1) {
      for (let x = 0; x < COLUMNS; x += 1) cellRect(x, y);
    }
    context.globalAlpha = 1;

    if (food) {
      context.fillStyle = colors.ink;
      pixelRect(food.x, food.y, 0.34, 0.14, 0.32, 0.72);
      pixelRect(food.x, food.y, 0.14, 0.34, 0.72, 0.32);
      context.fillStyle = colors.background;
      pixelRect(food.x, food.y, 0.43, 0.43, 0.14, 0.14);
    }

    snake.forEach((segment, index) => {
      context.fillStyle = colors.ink;
      cellRect(segment.x, segment.y);
      context.fillStyle = colors.background;
      if (index > 0) {
        pixelRect(segment.x, segment.y, 0.43, 0.43, 0.14, 0.14);
      } else if (direction.x !== 0) {
        const eyeX = direction.x > 0 ? 0.65 : 0.22;
        pixelRect(segment.x, segment.y, eyeX, 0.24, 0.12, 0.12);
        pixelRect(segment.x, segment.y, eyeX, 0.64, 0.12, 0.12);
      } else {
        const eyeY = direction.y > 0 ? 0.65 : 0.22;
        pixelRect(segment.x, segment.y, 0.24, eyeY, 0.12, 0.12);
        pixelRect(segment.x, segment.y, 0.64, eyeY, 0.12, 0.12);
      }
    });
  }

  function resizeCanvas() {
    const bounds = canvas.getBoundingClientRect();
    const displayWidth = bounds.width || 480;
    const displayHeight = bounds.height || displayWidth * ROWS / COLUMNS;
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 3);
    canvas.width = Math.max(COLUMNS, Math.round(displayWidth * pixelRatio));
    canvas.height = Math.max(ROWS, Math.round(displayHeight * pixelRatio));
    const style = window.getComputedStyle(canvas);
    colors = {
      background: style.getPropertyValue("--lcd-background").trim() || "#a7b879",
      ink: style.getPropertyValue("--lcd-ink").trim() || "#27351e",
    };
    draw();
  }

  function scheduleResize() {
    if (resizeFrame !== null) return;
    resizeFrame = window.requestAnimationFrame(() => {
      resizeFrame = null;
      resizeCanvas();
    });
  }

  function prepareAudio() {
    if (!soundEnabled) return null;
    try {
      if (!audioContext) {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextClass) return null;
        audioContext = new AudioContextClass();
      }
      if (audioContext.state === "suspended") audioContext.resume().catch(() => {});
      return audioContext;
    } catch {
      return null;
    }
  }

  function playTone(frequency, duration, delay = 0) {
    if (!soundEnabled || !audioContext || audioContext.state !== "running") return;
    try {
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      const start = audioContext.currentTime + delay;
      oscillator.type = "square";
      oscillator.frequency.setValueAtTime(frequency, start);
      gain.gain.setValueAtTime(0.025, start);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
      oscillator.connect(gain);
      gain.connect(audioContext.destination);
      oscillator.onended = () => {
        oscillator.disconnect();
        gain.disconnect();
      };
      oscillator.start(start);
      oscillator.stop(start + duration);
    } catch {
      // Sound is optional; unsupported audio never interrupts play.
    }
  }

  ui.start?.addEventListener("click", startGame);
  ui.pause?.addEventListener("click", () => state === "paused" ? resumeGame() : pauseGame());
  ui.overlayAction?.addEventListener("click", () => state === "paused" ? resumeGame() : startGame());
  ui.sound?.addEventListener("click", () => {
    soundEnabled = !soundEnabled;
    if (soundEnabled && !prepareAudio()) soundEnabled = false;
    savePreferences();
    updateUI();
  });
  ui.levelSelect?.addEventListener("change", event => {
    if (state === "running" || state === "paused") return;
    const value = Number(event.target.value);
    if (!Number.isInteger(value) || value < 1 || value > 9) return;
    selectedLevel = value;
    savePreferences();
    updateUI();
  });
  ui.resetBest?.addEventListener("click", () => {
    if (state === "running" || state === "paused") return;
    bestScore = 0;
    savePreferences();
    updateUI();
  });

  document.querySelectorAll("[data-direction]").forEach(button => {
    // A single click handler supports touch, mouse, and native keyboard activation.
    button.addEventListener("click", () => queueDirection(button.dataset.direction));
  });

  document.addEventListener("keydown", event => {
    if (state !== "running") return;
    if (event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest("input, select, textarea, [contenteditable]:not([contenteditable='false'])")) return;
    const nextDirection = KEY_DIRECTIONS[event.key];
    if (!nextDirection) return;
    event.preventDefault();
    queueDirection(nextDirection);
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) pauseGame("hidden");
  });
  window.addEventListener("blur", () => pauseGame("hidden"));
  window.addEventListener("pagehide", () => pauseGame("hidden"));
  window.addEventListener("resize", scheduleResize);
  if ("ResizeObserver" in window) new ResizeObserver(scheduleResize).observe(canvas);

  resetBoard();
  updateUI();
  resizeCanvas();
})();
