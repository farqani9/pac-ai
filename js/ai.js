/* ============================================================
 * ai.js — the learning brain.
 *
 * Records the player's directional choices as a variable-order
 * Markov model (order-1 + order-2). From it we:
 *   1. predict where the player will be in N tiles (interception),
 *   2. track prediction accuracy at real intersections,
 *   3. grow an "awareness" value that ramps ghost aggression.
 * The model persists in localStorage so the AI remembers you.
 * ============================================================ */

const STORE_KEY = "pacai.brain.v1";

const AI = {
  model: new Map(),   // contextKey -> Map(dirName -> count)
  history: [],        // recent committed directions (names)
  lastTile: null,     // {col,row} pac occupied last sample
  prevDir: null,      // direction used to arrive at lastTile

  decisions: 0,       // intersections seen
  hits: 0,            // correct predictions at intersections
  samples: 0,         // total tile transitions observed
  awareness: 0,       // 0..1 overall "how well it knows you"

  init() {
    this.load();
    this._recompute();
  },

  reset() {
    this.model = new Map();
    this.history = [];
    this.lastTile = null;
    this.prevDir = null;
    this.decisions = 0;
    this.hits = 0;
    this.samples = 0;
    this.awareness = 0;
    try { localStorage.removeItem(STORE_KEY); } catch (e) {}
  },

  get accuracy() { return this.decisions ? this.hits / this.decisions : 0; },

  // How many tiles ahead we extrapolate (grows with awareness).
  lookahead() { return 2 + Math.round(this.awareness * 6); },

  // How many ghosts hunt by prediction (the rest play classic).
  hunterCount() {
    const a = this.awareness;
    if (a >= 0.85) return 4;
    if (a >= 0.60) return 3;
    if (a >= 0.38) return 2;
    if (a >= 0.15) return 1;
    return 0;
  },

  _recompute() {
    const experience = Math.min(1, this.decisions / 120);
    this.awareness = experience * (0.35 + 0.65 * this.accuracy);
  },

  // ---- observation: call once per frame with the player ----
  observe(pac) {
    if (pac.dir === DIRS.NONE) return;
    const col = pac.col(), row = pac.row();
    if (this.lastTile && this.lastTile.col === col && this.lastTile.row === row) return;

    const actual = pac.dir.name;

    if (this.lastTile && this.prevDir) {
      // Was the tile we just left a genuine decision point?
      const exits = this._exits(this.lastTile.col, this.lastTile.row, this.prevDir);
      if (exits.length >= 2) {
        const predicted = this._predict(this.history, exits);
        this.decisions++;
        if (predicted && predicted.name === actual) this.hits++;
      }
    }

    this._record(this.history, actual);
    this.history.push(actual);
    if (this.history.length > 4) this.history.shift();
    this.samples++;

    this.lastTile = { col, row };
    this.prevDir = pac.dir;

    if (this.samples % 4 === 0) this._recompute();
  },

  _record(ctx, dirName) {
    for (let o = 1; o <= 2; o++) {
      if (ctx.length < o) continue;
      const key = ctx.slice(-o).join(">");
      let m = this.model.get(key);
      if (!m) { m = new Map(); this.model.set(key, m); }
      m.set(dirName, (m.get(dirName) || 0) + 1);
    }
  },

  // Non-reversing walkable exits from a tile, given arrival direction.
  _exits(col, row, arriveDir) {
    const back = opposite(arriveDir);
    const out = [];
    for (const d of MOVE_DIRS) {
      if (d === back) continue;
      const nc = ((col + d.x) % COLS + COLS) % COLS;
      const nr = row + d.y;
      if (Maze.isWalkable(nc, nr)) out.push(d);
    }
    return out;
  },

  // Pick the most likely option using the highest-order matching context.
  _predict(ctx, options) {
    for (let o = Math.min(2, ctx.length); o >= 1; o--) {
      const key = ctx.slice(-o).join(">");
      const m = this.model.get(key);
      if (!m) continue;
      let best = null, bestC = 0;
      for (const d of options) {
        const c = m.get(d.name) || 0;
        if (c > bestC) { bestC = c; best = d; }
      }
      if (best) return best;
    }
    return null;
  },

  // Roll the player's likely path forward to an interception tile.
  predictTile(pac) {
    let col = pac.col(), row = pac.row();
    let dir = pac.dir === DIRS.NONE ? DIRS.LEFT : pac.dir;
    const ctx = this.history.slice();
    const depth = this.lookahead();

    for (let i = 0; i < depth; i++) {
      const opts = this._exits(col, row, dir);
      if (opts.length === 0) break;
      let nd;
      if (opts.length === 1) {
        nd = opts[0];
      } else {
        nd = this._predict(ctx, opts) || this._straightOr(opts, dir);
      }
      col = ((col + nd.x) % COLS + COLS) % COLS;
      row += nd.y;
      if (row < 0 || row >= ROWS) break;
      ctx.push(nd.name);
      if (ctx.length > 4) ctx.shift();
      dir = nd;
    }
    return { col, row };
  },

  _straightOr(options, dir) {
    for (const d of options) if (d === dir) return d;
    return options[0];
  },

  // ---- persistence ----
  save() {
    try {
      const obj = {};
      for (const [k, m] of this.model) {
        obj[k] = {};
        for (const [d, c] of m) obj[k][d] = c;
      }
      localStorage.setItem(STORE_KEY, JSON.stringify({
        model: obj, decisions: this.decisions, hits: this.hits, samples: this.samples,
      }));
    } catch (e) { /* storage may be unavailable */ }
  },

  load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      this.model = new Map();
      for (const k of Object.keys(data.model || {})) {
        const m = new Map();
        for (const d of Object.keys(data.model[k])) m.set(d, data.model[k][d]);
        this.model.set(k, m);
      }
      this.decisions = data.decisions || 0;
      this.hits = data.hits || 0;
      this.samples = data.samples || 0;
    } catch (e) { /* ignore corrupt store */ }
  },

  patternCount() { return this.model.size; },
};
