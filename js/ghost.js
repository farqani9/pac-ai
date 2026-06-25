/* ============================================================
 * ghost.js — four ghosts, classic scatter/chase/frightened/eaten
 * Movement: at each tile center pick the non-reversing exit that
 * minimises distance to the ghost's current target tile.
 * The target tile is what the learning AI rewrites (see ai.js/game.js).
 * ============================================================ */

const GS = {
  HOME: "HOME",         // waiting inside the house
  LEAVING: "LEAVING",   // scripted exit up through the door
  ACTIVE: "ACTIVE",     // roaming the maze (scatter/chase, maybe frightened)
  EATEN: "EATEN",       // eyes returning to the house
  ENTERING: "ENTERING", // scripted descent back into the house
};

class Ghost {
  constructor(opts) {
    this.name = opts.name;
    this.color = opts.color;
    this.scatterTarget = opts.scatter;      // {col,row} home corner
    this.homeSpot = opts.home;              // {col,row} seat inside the house
    this.startActive = !!opts.startActive;  // Blinky starts in the maze
    this.releaseDelay = opts.releaseDelay;  // frames before leaving the house
    this.reset();
  }

  reset() {
    const seat = this.startActive ? Maze.houseExit : this.homeSpot;
    this.x = tileCenter(seat.col);
    this.y = tileCenter(seat.row);
    this.dir = DIRS.LEFT;
    this._acc = 0;
    this.frightened = false;
    this.target = { col: Maze.pacStart.col, row: Maze.pacStart.row };
    this.releaseTimer = this.releaseDelay;
    this.hunter = false;        // set by AI when this ghost predicts ahead
    this.bob = Math.random() * Math.PI * 2;
    if (this.startActive) {
      this.state = GS.ACTIVE;
    } else {
      this.state = GS.HOME;
    }
  }

  col() { return Math.floor(this.x / TILE); }
  row() { return Math.floor(this.y / TILE); }

  // ---- target selection ----
  currentTarget() {
    if (this.state === GS.EATEN) return Maze.houseExit;
    if (Game.mode === "SCATTER" && !this.frightened) return this.scatterTarget;
    return this.target; // chase target (personality / AI), set each frame by Game
  }

  reverse() { this.dir = opposite(this.dir); }

  // ---- per-frame speed depending on state & location ----
  computeSpeed() {
    if (this.state === GS.EATEN) return 4.2;
    if (this.state === GS.LEAVING || this.state === GS.ENTERING) return 1.7;
    if (this.frightened) return 1.25;
    let s = Game.ghostSpeed(this);            // AI/level-scaled base speed
    if (Maze.isTunnelRow(this.row())) s *= 0.6;
    return s;
  }

  // ---- main update ----
  update() {
    if (this.state === GS.HOME) {
      this.bob += 0.12;
      this.y = tileCenter(this.homeSpot.row) + Math.sin(this.bob) * 3;
      if (Game.releasing && this.releaseTimer-- <= 0) this.state = GS.LEAVING;
      return;
    }
    this.speed = this.computeSpeed();
    gridAdvance(this);
  }

  chooseDirection(centered) {
    if (this.state === GS.LEAVING) return this.stepLeaving();
    if (this.state === GS.ENTERING) return this.stepEntering();
    if (!centered) return;

    const c = this.col(), r = this.row();

    // EATEN ghost reached the lobby above the door → descend.
    if (this.state === GS.EATEN && c === Maze.houseExit.col && r === Maze.houseExit.row) {
      this.state = GS.ENTERING;
      return this.stepEntering();
    }

    const canDoor = this.state === GS.EATEN;
    const options = [];
    for (const d of MOVE_DIRS) {
      if (d === opposite(this.dir)) continue;          // never reverse mid-path
      let nc = ((c + d.x) % COLS + COLS) % COLS;        // tunnel-aware
      const nr = r + d.y;
      if (Maze.ghostWalkable(nc, nr, canDoor)) options.push(d);
    }
    if (options.length === 0) { this.dir = opposite(this.dir); return; }

    if (this.frightened && this.state === GS.ACTIVE) {
      this.dir = options[(Math.random() * options.length) | 0];
      return;
    }

    const t = this.currentTarget();
    let best = options[0], bestDist = Infinity;
    for (const d of options) {
      const nc = c + d.x, nr = r + d.y;
      const dist = (nc - t.col) ** 2 + (nr - t.row) ** 2;
      if (dist < bestDist) { bestDist = dist; best = d; }
    }
    this.dir = best;
  }

  // Scripted exit: centre on the door column, rise into the lobby.
  stepLeaving() {
    const ex = tileCenter(Maze.houseExit.col);
    const ey = tileCenter(Maze.houseExit.row);
    if (this.x !== ex) { this.dir = this.x > ex ? DIRS.LEFT : DIRS.RIGHT; return; }
    if (this.y > ey) { this.dir = DIRS.UP; return; }
    // arrived in the lobby
    this.x = ex; this.y = ey;
    this.state = GS.ACTIVE;
    this.dir = DIRS.LEFT;
  }

  // Scripted descent for eaten ghosts: down the door into the seat.
  stepEntering() {
    const sx = tileCenter(Maze.houseExit.col);
    const sy = tileCenter(this.homeSpot.row);
    if (this.x !== sx) { this.dir = this.x > sx ? DIRS.LEFT : DIRS.RIGHT; return; }
    if (this.y < sy) { this.dir = DIRS.DOWN; return; }
    // revived in the house
    this.x = tileCenter(this.homeSpot.col); this.y = sy;
    this.state = GS.HOME;
    this.frightened = false;
    this.releaseTimer = 40;
    this.bob = 0;
  }

  // ---- rendering ----
  draw(ctx, flashing) {
    const r = TILE / 2 + 1;
    const x = this.x, y = this.y;

    if (this.state === GS.EATEN) { this._drawEyes(ctx, x, y, r); return; }

    let body = this.color;
    if (this.frightened) body = flashing ? "#ffffff" : "#2331d6";

    ctx.save();
    ctx.fillStyle = body;
    if (!this.frightened) { ctx.shadowColor = body; ctx.shadowBlur = 10; }
    // dome + wavy skirt
    ctx.beginPath();
    ctx.arc(x, y - 1, r, Math.PI, 0);
    const feet = 4, baseY = y + r - 1;
    ctx.lineTo(x + r, baseY);
    for (let i = 0; i < feet; i++) {
      const seg = (r * 2) / feet;
      const fx = x + r - seg * i;
      ctx.quadraticCurveTo(fx - seg / 2, baseY - 4, fx - seg, baseY);
    }
    ctx.closePath();
    ctx.fill();
    ctx.shadowBlur = 0;

    if (this.frightened) {
      ctx.fillStyle = flashing ? "#ff0000" : "#ffd9f5";
      // eyes
      ctx.fillRect(x - 5, y - 3, 3, 3);
      ctx.fillRect(x + 2, y - 3, 3, 3);
      // squiggly mouth
      ctx.strokeStyle = flashing ? "#ff0000" : "#ffd9f5";
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(x - 6, y + 5);
      ctx.lineTo(x - 3, y + 2);
      ctx.lineTo(x, y + 5);
      ctx.lineTo(x + 3, y + 2);
      ctx.lineTo(x + 6, y + 5);
      ctx.stroke();
    } else {
      this._drawEyes(ctx, x, y, r);
      if (this.hunter) {
        // crosshair marker when this ghost is actively predicting you
        ctx.strokeStyle = "rgba(255,255,255,0.9)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(x, y - r - 4, 2.4, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  _drawEyes(ctx, x, y, r) {
    const dx = this.dir.x * 2, dy = this.dir.y * 2;
    ctx.fillStyle = "#fff";
    ctx.beginPath(); ctx.arc(x - 4, y - 2, 3.2, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(x + 4, y - 2, 3.2, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#1b1bff";
    ctx.beginPath(); ctx.arc(x - 4 + dx, y - 2 + dy, 1.6, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(x + 4 + dx, y - 2 + dy, 1.6, 0, Math.PI * 2); ctx.fill();
  }
}

// Factory: the canonical four, with scatter corners & house seats.
function makeGhosts() {
  return [
    new Ghost({ name: "blinky", color: "#ff2b2b",
      scatter: { col: COLS - 3, row: 0 }, home: { col: 13, row: 14 },
      startActive: true, releaseDelay: 0 }),
    new Ghost({ name: "pinky", color: "#ffade0",
      scatter: { col: 2, row: 0 }, home: { col: 13, row: 14 },
      startActive: false, releaseDelay: 30 }),
    new Ghost({ name: "inky", color: "#36e6ff",
      scatter: { col: COLS - 1, row: ROWS - 1 }, home: { col: 11, row: 14 },
      startActive: false, releaseDelay: 180 }),
    new Ghost({ name: "clyde", color: "#ffb13b",
      scatter: { col: 0, row: ROWS - 1 }, home: { col: 16, row: 14 },
      startActive: false, releaseDelay: 360 }),
  ];
}
