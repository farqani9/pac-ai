/* ============================================================
 * game.js — main loop, rules, scoring, and AI ⇄ ghost wiring
 * ============================================================ */

const STEP = 1000 / 60;

// Global scatter/chase schedule (seconds), classic-style.
const MODE_PHASES = [
  { mode: "SCATTER", t: 7 },
  { mode: "CHASE", t: 20 },
  { mode: "SCATTER", t: 7 },
  { mode: "CHASE", t: 20 },
  { mode: "SCATTER", t: 5 },
  { mode: "CHASE", t: 20 },
  { mode: "SCATTER", t: 5 },
  { mode: "CHASE", t: Infinity },
];

const Game = {
  state: "TITLE",   // TITLE | READY | PLAYING | DYING | CLEAR | OVER | PAUSED
  mode: "SCATTER",
  releasing: false,
  debug: false,
  godMode: false,

  score: 0,
  high: 0,
  level: 1,
  lives: 3,
  extraAwarded: false,

  time: 0,
  modeIndex: 0,
  modeTimer: 0,
  frightTimer: 0,
  frightTotal: 0,
  combo: 200,
  freezeTimer: 0,
  predicted: { col: 0, row: 0 },
  predPath: [],
  _plan: null,
  _planTimer: 0,

  init() {
    this.canvas = document.getElementById("game");
    this.canvas.width = Maze.width;
    this.canvas.height = Maze.height;
    this.ctx = this.canvas.getContext("2d");

    this.high = Number(localStorage.getItem("pacai.high") || 0);

    Maze.reset();
    AI.init();
    this.pac = new Pacman();
    this.ghosts = makeGhosts();

    Input.init();
    Input.onStart = () => this.primaryAction();
    Input.onDebug = () => { this.debug = !this.debug; };
    Input.onPause = () => {
      if (this.state === "PLAYING") this.state = "PAUSED";
      else if (this.state === "PAUSED") this.state = "PLAYING";
    };

    document.getElementById("startBtn").onclick = () => this.primaryAction();
    document.getElementById("resetBrain").onclick = () => {
      AI.reset();
      this.updateBrain();
      flashNote("AI memory wiped. The ghosts forgot everything about you.");
    };

    // God mode: untouchable Pac-Man so you can watch the AI learn forever.
    this.godMode = localStorage.getItem("pacai.god") === "1";
    const godBtn = document.getElementById("godMode");
    const syncGod = () => {
      godBtn.textContent = "GOD MODE: " + (this.godMode ? "ON" : "OFF");
      godBtn.classList.toggle("on", this.godMode);
    };
    const toggleGod = () => {
      this.godMode = !this.godMode;
      localStorage.setItem("pacai.god", this.godMode ? "1" : "0");
      syncGod();
      flashNote(this.godMode
        ? "God mode ON — ghosts can't catch you. Roam and watch awareness climb."
        : "God mode OFF — mortal again.");
    };
    godBtn.onclick = toggleGod;
    Input.onGod = toggleGod;
    syncGod();

    window.addEventListener("beforeunload", () => AI.save());

    this.showTitle();
    this.updateHud();
    this.updateBrain();

    let last = performance.now();
    let acc = 0;
    const frame = (now) => {
      acc += now - last; last = now;
      if (acc > 250) acc = 250;            // avoid spiral after tab-away
      while (acc >= STEP) { this.step(); acc -= STEP; }
      this.render(now);
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  },

  // ---------- lifecycle ----------
  // The big overlay button / Enter / Space does the right thing per state.
  primaryAction() {
    if (this.state === "WIN") this.advanceLevel();
    else if (this.state === "TITLE" || this.state === "OVER") this.startGame();
  },

  showTitle() {
    this.state = "TITLE";
    setOverlay(`<div>The ghosts study how you move and learn to cut you off.<br>
      Survive while they get smarter.</div>`, "PLAY");
  },

  startGame() {
    this.score = 0;
    this.level = 1;
    this.lives = 3;
    this.extraAwarded = false;
    Maze.reset();
    this.startLevel();
    hideOverlay();
    this.updateHud();
  },

  startLevel() {
    this.pac.reset();
    this.ghosts = makeGhosts();
    this.mode = "SCATTER";
    this.modeIndex = 0;
    this.modeTimer = 0;
    this.frightTimer = 0;
    this.releasing = false;
    this.combo = 200;
    this.freezeTimer = 50;     // "READY!" beat
    this.state = "READY";
    Input.desired = DIRS.NONE;
  },

  nextLife() {
    this.pac.reset();
    this.ghosts = makeGhosts();
    this.mode = "SCATTER";
    this.modeIndex = 0;
    this.modeTimer = 0;
    this.frightTimer = 0;
    this.releasing = false;
    this.combo = 200;
    this.freezeTimer = 50;
    this.state = "READY";
    Input.desired = DIRS.NONE;
  },

  // ---------- fixed-step update ----------
  step() {
    this.time += STEP;
    switch (this.state) {
      case "READY":
        if (--this.freezeTimer <= 0) { this.state = "PLAYING"; this.releasing = true; }
        break;
      case "PLAYING":
        this.updatePlaying();
        break;
      case "DYING":
        this.pac.update();
        if (this.pac.deathTimer > 90) this.afterDeath();
        break;
    }
  },

  updatePlaying() {
    this.pac.update();
    AI.observe(this.pac, this.ghosts);

    // eat pellet under Pac-Man
    const v = Maze.eat(this.pac.col(), this.pac.row());
    if (v === 1) this.addScore(10);
    else if (v === 2) { this.addScore(50); this.startFright(); }

    // mode schedule (frozen while ghosts are frightened)
    if (this.frightTimer <= 0) {
      this.modeTimer += STEP;
      const phase = MODE_PHASES[this.modeIndex];
      if (this.modeTimer >= phase.t * 1000 && this.modeIndex < MODE_PHASES.length - 1) {
        this.modeIndex++;
        this.modeTimer = 0;
        this.mode = MODE_PHASES[this.modeIndex].mode;
        this.flipReverse();
      }
    } else {
      this.frightTimer -= STEP;
      if (this.frightTimer <= 0) this.endFright();
    }

    this.assignTargets();
    for (const g of this.ghosts) g.update();
    this.checkCollisions();

    if (Maze.cleared()) this.winLevel();

    if (this.time % 600 < STEP) AI.save();   // periodic checkpoint (~10s)
  },

  // ---------- AI ⇄ ghost targeting ----------
  assignTargets() {
    const pac = this.pac;
    const blinky = this.ghosts[0];
    this.predPath = AI.predictPath(pac, this.ghosts);
    this.predicted = this.predPath.length
      ? this.predPath[this.predPath.length - 1]
      : { col: pac.col(), row: pac.row() };
    const hunters = AI.hunterCount();

    // Baseline: everyone plays their classic personality.
    const aheadOf = (n) => ({
      col: pac.col() + pac.dir.x * n,
      row: pac.row() + pac.dir.y * n,
    });
    const personality = {
      blinky: () => ({ col: pac.col(), row: pac.row() }),
      pinky: () => aheadOf(4),
      inky: () => {
        const p = aheadOf(2);
        return { col: p.col * 2 - blinky.col(), row: p.row * 2 - blinky.row() };
      },
      clyde: (g) => {
        const d = Math.hypot(g.col() - pac.col(), g.row() - pac.row());
        return d > 8 ? { col: pac.col(), row: pac.row() } : g.scatterTarget;
      },
    };
    for (const g of this.ghosts) { g.target = personality[g.name](g); g.hunter = false; }

    // Tier 2: the most-aware ghosts coordinate a trap instead of chasing.
    if (this.mode !== "CHASE" || hunters <= 0) return;
    const hunterGhosts = [];
    for (const g of this.ghosts) {
      if (hunterGhosts.length >= hunters) break;
      if (g.state === GS.ACTIVE && !g.frightened) hunterGhosts.push(g);
    }
    if (hunterGhosts.length === 0) return;

    // Recompute the plan a few times a second (BFS is cheap but not free).
    if (this._planTimer <= 0 || !this._plan) {
      this._plan = this.buildTrapPlan(pac, hunterGhosts);
      this._planTimer = 12;
    } else {
      this._planTimer--;
    }
    for (const g of hunterGhosts) {
      const pt = this._plan.get(g);
      if (pt) { g.target = pt; g.hunter = true; }
    }
  },

  // Candidate intercept tiles, most valuable first.
  trapPoints(pac) {
    const path = this.predPath;
    const ahead = this.predicted;                                   // deep cut-off
    const mid = path.length ? path[Math.floor(path.length / 2)] : ahead; // near cut-off
    const cur = { col: pac.col(), row: pac.row() };                 // pincer from behind
    const camp = AI.hotTileNear(pac.col(), pac.row(), 6) || ahead;  // favourite-spot ambush
    return [ahead, mid, camp, cur];
  },

  // Assign each hunter the intercept point it can reach fastest, so they
  // naturally split into a front/back pincer (coordination, not clumping).
  buildTrapPlan(pac, hunterGhosts) {
    const points = this.trapPoints(pac);
    const fields = hunterGhosts.map((g) => Maze.bfsField(g.col(), g.row()));
    const plan = new Map();
    for (const pt of points) {
      if (plan.size >= hunterGhosts.length) break;
      const idx = pt.row * COLS + pt.col;
      let best = -1, bestD = Infinity;
      for (let i = 0; i < hunterGhosts.length; i++) {
        if (plan.has(hunterGhosts[i])) continue;
        let d = fields[i][idx];
        if (d < 0) d = 9999;                 // unreachable (shouldn't happen)
        if (d < bestD) { bestD = d; best = i; }
      }
      if (best >= 0) plan.set(hunterGhosts[best], pt);
    }
    // any leftover hunter heads for the predicted tile
    for (const g of hunterGhosts) if (!plan.has(g)) plan.set(g, this.predicted);
    return plan;
  },

  flipReverse() {
    for (const g of this.ghosts) {
      if (g.state === GS.ACTIVE && !g.frightened) g.reverse();
    }
  },

  ghostSpeed() {
    const base = 1.7 + AI.awareness * 0.55 + (this.level - 1) * 0.05;
    return Math.min(base, 2.45);
  },

  // ---------- frightened mode ----------
  startFright() {
    const dur = Math.max(2.5, 7 - (this.level - 1) * 0.4 - AI.awareness * 1.5);
    this.frightTimer = dur * 1000;
    this.frightTotal = this.frightTimer;
    this.combo = 200;
    for (const g of this.ghosts) {
      if (g.state === GS.ACTIVE) { g.frightened = true; g.reverse(); }
    }
  },

  endFright() {
    this.frightTimer = 0;
    for (const g of this.ghosts) g.frightened = false;
  },

  get frightFlashing() {
    return this.frightTimer > 0 && this.frightTimer < 2000 &&
      Math.floor(this.frightTimer / 250) % 2 === 0;
  },

  // ---------- collisions ----------
  checkCollisions() {
    const pac = this.pac;
    for (const g of this.ghosts) {
      if (g.state !== GS.ACTIVE) continue;
      if (Math.hypot(pac.x - g.x, pac.y - g.y) > TILE * 0.55) continue;
      if (g.frightened) {
        g.state = GS.EATEN;
        g.frightened = false;
        this.addScore(this.combo);
        this.combo = Math.min(this.combo * 2, 1600);
      } else if (!this.godMode) {
        this.killPac();
        return;
      }
    }
  },

  killPac() {
    this.pac.dead = true;
    this.pac.deathTimer = 0;
    this.state = "DYING";
    this.releasing = false;
    AI.save();
  },

  afterDeath() {
    this.lives--;
    this.updateHud();
    if (this.lives <= 0) {
      this.gameOver();
    } else {
      this.nextLife();
    }
  },

  // Board cleared → celebratory win screen that waits for the player.
  winLevel() {
    this.state = "WIN";
    this.releasing = false;
    if (this.score > this.high) {
      this.high = this.score;
      localStorage.setItem("pacai.high", String(this.high));
    }
    AI.save();
    const a = Math.round(AI.awareness * 100);
    const acc = AI.decisions ? Math.round(AI.accuracy * 100) + "%" : "—";
    setOverlay(`<div class="big">🏆 MAZE CLEARED!</div>
      <div>Level ${this.level} · Score ${this.score}</div>
      <div style="margin-top:10px;color:#ff8cf0">
        The ghosts are <b>${a}%</b> aware of your habits
        (${acc} prediction accuracy).</div>
      <div style="margin-top:6px;color:#7c86b8">Next level: faster ghosts, sharper predictions.</div>`,
      "NEXT LEVEL ▶");
  },

  advanceLevel() {
    this.level++;
    Maze.reset();
    this.startLevel();
    hideOverlay();
    this.updateHud();
  },

  gameOver() {
    this.state = "OVER";
    if (this.score > this.high) {
      this.high = this.score;
      localStorage.setItem("pacai.high", String(this.high));
    }
    AI.save();
    const a = Math.round(AI.awareness * 100);
    setOverlay(`<div class="big">GAME OVER</div>
      <div>Score ${this.score} · Level ${this.level}</div>
      <div style="margin-top:8px;color:#ff8cf0">The ghosts are ${a}% aware of your habits.</div>`,
      "PLAY AGAIN");
    this.updateHud();
  },

  addScore(n) {
    this.score += n;
    if (!this.extraAwarded && this.score >= 10000) {
      this.extraAwarded = true;
      this.lives++;
    }
    this.updateHud();
  },

  // ---------- rendering ----------
  render(now) {
    const ctx = this.ctx;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, Maze.width, Maze.height);

    Maze.drawWalls(ctx);
    Maze.drawPellets(ctx, now);

    if (this.debug) this.drawDebug(ctx);

    if (this.state !== "DYING") {
      for (const g of this.ghosts) g.draw(ctx, this.frightFlashing);
    }
    this.pac.draw(ctx, this.godMode);

    if (this.state === "READY") this.banner(ctx, "READY!", "#ffe600");
    if (this.state === "PAUSED") this.banner(ctx, "PAUSED", "#00e5ff");

    this.updateBrain();
  },

  banner(ctx, text, color) {
    ctx.save();
    ctx.fillStyle = color;
    ctx.font = "bold 26px Segoe UI, sans-serif";
    ctx.textAlign = "center";
    ctx.shadowColor = color;
    ctx.shadowBlur = 16;
    ctx.fillText(text, Maze.width / 2, Maze.height * 0.62);
    ctx.restore();
  },

  drawDebug(ctx) {
    ctx.save();
    // predicted player path
    ctx.fillStyle = "rgba(255,255,255,0.35)";
    for (const t of this.predPath) {
      ctx.fillRect(t.col * TILE + 7, t.row * TILE + 7, TILE - 14, TILE - 14);
    }
    // predicted endpoint
    const p = this.predicted;
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.lineWidth = 2;
    ctx.strokeRect(p.col * TILE + 2, p.row * TILE + 2, TILE - 4, TILE - 4);
    ctx.beginPath();
    ctx.moveTo(this.pac.x, this.pac.y);
    ctx.lineTo(tileCenter(p.col), tileCenter(p.row));
    ctx.stroke();
    // each ghost's assigned target tile (hunters drawn brighter + linked)
    for (const g of this.ghosts) {
      const t = g.currentTarget();
      ctx.fillStyle = g.color;
      ctx.globalAlpha = g.hunter ? 0.85 : 0.4;
      ctx.fillRect(t.col * TILE + 6, t.row * TILE + 6, TILE - 12, TILE - 12);
      if (g.hunter) {
        ctx.globalAlpha = 0.6;
        ctx.strokeStyle = g.color;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(g.x, g.y);
        ctx.lineTo(tileCenter(t.col), tileCenter(t.row));
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  },

  // ---------- HUD / brain panel ----------
  updateHud() {
    document.getElementById("score").textContent = this.score;
    document.getElementById("highscore").textContent = Math.max(this.high, this.score);
    document.getElementById("level").textContent = this.level;
    document.getElementById("lives").textContent = Math.max(0, this.lives);
  },

  updateBrain() {
    const a = AI.awareness;
    const acc = AI.accuracy;
    set("awarenessPct", Math.round(a * 100) + "%");
    set("accuracyPct", AI.decisions ? Math.round(acc * 100) + "%" : "—");
    document.getElementById("awarenessBar").style.width = (a * 100) + "%";
    document.getElementById("accuracyBar").style.width = (acc * 100) + "%";
    set("statSamples", AI.samples);
    set("statPatterns", AI.patternCount());
    set("statHunters", AI.hunterCount());
    set("statLookahead", AI.lookahead());
    const note = document.getElementById("brainNote");
    if (note) note.textContent =
      a < 0.15 ? "Ghosts are playing classic. Keep moving — they're watching." :
      a < 0.38 ? "One ghost predicts where you're heading and reads the threat around you." :
      a < 0.60 ? "Two ghosts split up — one cuts ahead, one camps your favourite spot." :
      a < 0.85 ? "Three ghosts coordinate a pincer: front, flank and behind." :
      "All four ghosts coordinate to trap you — predicting your escape and closing it.";
  },
};

// ---- small DOM helpers ----
function set(id, v) { const el = document.getElementById(id); if (el) el.textContent = v; }
function setOverlay(bodyHtml, btnLabel) {
  document.getElementById("overlay-body").innerHTML = bodyHtml;
  document.getElementById("startBtn").textContent = btnLabel;
  document.getElementById("overlay").classList.remove("hidden");
}
function hideOverlay() { document.getElementById("overlay").classList.add("hidden"); }
function flashNote(msg) {
  const note = document.getElementById("brainNote");
  if (!note) return;
  const prev = note.textContent;
  note.textContent = msg;
  note.style.color = "#ffe600";
  setTimeout(() => { note.style.color = ""; }, 2500);
}

window.addEventListener("DOMContentLoaded", () => Game.init());
