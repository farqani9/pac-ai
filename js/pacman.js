/* ============================================================
 * pacman.js — the player + the shared grid-movement helper
 * ============================================================ */

// True when a pixel coordinate sits exactly on a tile center.
function onCenterAxis(px) { return (((px % TILE) + TILE) % TILE) === TILE / 2; }

// Advance an entity by entity.speed pixels this frame, one pixel at a
// time, so it always lands exactly on tile centers (turns + tunnel stay
// reliable at any speed). The entity supplies chooseDirection(centered).
function gridAdvance(e) {
  e._acc = (e._acc || 0) + e.speed;
  let steps = Math.floor(e._acc);
  e._acc -= steps;
  while (steps-- > 0) {
    const centered = onCenterAxis(e.x) && onCenterAxis(e.y);
    e.chooseDirection(centered);
    if (e.dir === DIRS.NONE) break;
    e.x += e.dir.x;
    e.y += e.dir.y;
    e.x = ((e.x % Maze.width) + Maze.width) % Maze.width;     // tunnel wrap
    e.y = ((e.y % Maze.height) + Maze.height) % Maze.height;
  }
}

class Pacman {
  constructor() { this.reset(); }

  reset() {
    this.x = tileCenter(Maze.pacStart.col);
    this.y = tileCenter(Maze.pacStart.row);
    this.dir = DIRS.LEFT;
    this.speed = 2.1;
    this._acc = 0;
    this.mouth = 0;          // animation phase
    this.dead = false;
    this.deathTimer = 0;
  }

  col() { return Math.floor(this.x / TILE); }
  row() { return Math.floor(this.y / TILE); }

  canGo(dir) {
    if (dir === DIRS.NONE) return false;
    let nc = this.col() + dir.x;
    const nr = this.row() + dir.y;
    nc = ((nc % COLS) + COLS) % COLS;          // tunnel-aware
    return Maze.isWalkable(nc, nr);
  }

  chooseDirection(centered) {
    const d = Input.desired;
    // Instant reverse feels responsive and is classic behaviour.
    if (d !== DIRS.NONE && this.dir !== DIRS.NONE && d === opposite(this.dir)) {
      this.dir = d;
      return;
    }
    if (!centered) return;
    if (d !== DIRS.NONE && this.canGo(d)) this.dir = d;
    if (!this.canGo(this.dir)) this.dir = DIRS.NONE;
  }

  update() {
    if (this.dead) { this.deathTimer++; return; }
    gridAdvance(this);
    // mouth opens/closes while moving
    if (this.dir !== DIRS.NONE) this.mouth += 0.25;
  }

  draw(ctx) {
    const r = TILE / 2 + 1;
    ctx.save();
    ctx.translate(this.x, this.y);
    const ang = this.dir === DIRS.LEFT ? Math.PI
      : this.dir === DIRS.UP ? -Math.PI / 2
      : this.dir === DIRS.DOWN ? Math.PI / 2 : 0;
    ctx.rotate(ang);

    if (this.dead) {
      // Shrinking death animation.
      const t = Math.min(this.deathTimer / 55, 1);
      const open = t * Math.PI;
      ctx.fillStyle = "#ffe600";
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, r * (1 - t * 0.6), open, Math.PI * 2 - open);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
      return;
    }

    const open = (Math.sin(this.mouth) * 0.5 + 0.5) * 0.32 * Math.PI + 0.04;
    const grad = ctx.createRadialGradient(-2, -2, 2, 0, 0, r);
    grad.addColorStop(0, "#fff7a8");
    grad.addColorStop(1, "#ffd000");
    ctx.fillStyle = grad;
    ctx.shadowColor = "#ffe600";
    ctx.shadowBlur = 12;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, r, open, Math.PI * 2 - open);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
}
