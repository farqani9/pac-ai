/* ============================================================
 * ai.js — the learning brain.
 *
 * Tier 1 (situational prediction): the player's directional choices
 * feed a variable-order Markov model whose context includes not just
 * the last 1–2 moves but the *direction of the nearest threat* — so it
 * learns things like "when chased from the left, this player bolts for
 * the tunnel". From it we:
 *   1. predict the player's likely path forward (interception),
 *   2. track prediction accuracy at real intersections,
 *   3. grow an "awareness" value that ramps ghost aggression,
 *   4. keep a decaying heatmap of where the player likes to be
 *      (used by the trapping logic in game.js).
 * The model persists in localStorage so the AI remembers you.
 * ============================================================ */

const STORE_KEY = "pacai.brain.v2";
const THREAT_RADIUS = 8;   // tiles within which a ghost counts as "the threat"

const AI = {
  model: new Map(),   // contextKey -> Map(dirName -> count)
  history: [],        // recent committed directions (names)
  heat: null,         // [row][col] decaying visit counts
  lastTile: null,     // {col,row} pac occupied last sample
  prevDir: null,      // direction used to arrive at lastTile
  lastThreat: "N",    // threat token observed at lastTile

  decisions: 0,       // intersections seen
  hits: 0,            // correct predictions at intersections
  samples: 0,         // total tile transitions observed
  awareness: 0,       // 0..1 overall "how well it knows you"

  init() {
    this._initHeat();
    this.load();
    this._recompute();
  },

  reset() {
    this.model = new Map();
    this.history = [];
    this._initHeat();
    this.lastTile = null;
    this.prevDir = null;
    this.lastThreat = "N";
    this.decisions = 0;
    this.hits = 0;
    this.samples = 0;
    this.awareness = 0;
    try { localStorage.removeItem(STORE_KEY); } catch (e) {}
  },

  _initHeat() {
    this.heat = Array.from({ length: ROWS }, () => new Array(COLS).fill(0));
  },

  get accuracy() { return this.decisions ? this.hits / this.decisions : 0; },

  lookahead() { return 2 + Math.round(this.awareness * 6); },

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

  // ---- threat token: direction of the nearest dangerous ghost ----
  threatToken(pac, ghosts) {
    if (!ghosts) return "N";
    let best = null, bestD = Infinity;
    for (const g of ghosts) {
      if (g.state !== GS.ACTIVE || g.frightened) continue;
      const dc = g.col() - pac.col(), dr = g.row() - pac.row();
      const d = Math.abs(dc) + Math.abs(dr);
      if (d < bestD) { bestD = d; best = { dc, dr }; }
    }
    if (!best || bestD > THREAT_RADIUS) return "N";
    if (Math.abs(best.dc) >= Math.abs(best.dr)) return best.dc > 0 ? "R" : "L";
    return best.dr > 0 ? "D" : "U";
  },

  // ---- observation: call once per frame with player + ghosts ----
  observe(pac, ghosts) {
    if (pac.dir === DIRS.NONE) return;
    const col = pac.col(), row = pac.row();
    if (this.lastTile && this.lastTile.col === col && this.lastTile.row === row) return;

    const actual = pac.dir.name;

    if (this.lastTile && this.prevDir) {
      const exits = this._exits(this.lastTile.col, this.lastTile.row, this.prevDir);
      if (exits.length >= 2) {
        const predicted = this._predict(this.history, exits, this.lastThreat);
        this.decisions++;
        if (predicted && predicted.name === actual) this.hits++;
      }
    }

    this._record(this.history, actual, this.lastThreat);
    this.history.push(actual);
    if (this.history.length > 4) this.history.shift();
    this.samples++;
    this._bumpHeat(col, row);

    this.lastTile = { col, row };
    this.prevDir = pac.dir;
    this.lastThreat = this.threatToken(pac, ghosts);

    if (this.samples % 4 === 0) this._recompute();
  },

  _record(ctx, dirName, threat) {
    for (let o = 1; o <= 2; o++) {
      if (ctx.length < o) continue;
      this._inc(ctx.slice(-o).join(">"), dirName);
    }
    if (threat && threat !== "N") {
      this._inc("T:" + threat + "|" + (ctx[ctx.length - 1] || "_"), dirName);
      this._inc("T:" + threat, dirName);
    }
  },

  _inc(key, dirName) {
    let m = this.model.get(key);
    if (!m) { m = new Map(); this.model.set(key, m); }
    m.set(dirName, (m.get(dirName) || 0) + 1);
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

  // Pick the most likely option, trying the most situational context first.
  _predict(ctx, options, threat) {
    const last = ctx[ctx.length - 1] || "_";
    const keys = [];
    if (threat && threat !== "N") keys.push("T:" + threat + "|" + last);
    if (ctx.length >= 2) keys.push(ctx.slice(-2).join(">"));
    if (ctx.length >= 1) keys.push(ctx.slice(-1).join(">"));
    if (threat && threat !== "N") keys.push("T:" + threat);

    for (const key of keys) {
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

  // Roll the player's likely path forward; returns the list of tiles.
  predictPath(pac, ghosts) {
    let col = pac.col(), row = pac.row();
    let dir = pac.dir === DIRS.NONE ? DIRS.LEFT : pac.dir;
    const ctx = this.history.slice();
    const threat = this.threatToken(pac, ghosts);
    const depth = this.lookahead();
    const path = [];

    for (let i = 0; i < depth; i++) {
      const opts = this._exits(col, row, dir);
      if (opts.length === 0) break;
      let nd;
      if (opts.length === 1) nd = opts[0];
      else nd = this._predict(ctx, opts, i === 0 ? threat : "N") || this._straightOr(opts, dir);
      col = ((col + nd.x) % COLS + COLS) % COLS;
      row += nd.y;
      if (row < 0 || row >= ROWS) break;
      path.push({ col, row });
      ctx.push(nd.name);
      if (ctx.length > 4) ctx.shift();
      dir = nd;
    }
    return path;
  },

  predictTile(pac, ghosts) {
    const p = this.predictPath(pac, ghosts);
    return p.length ? p[p.length - 1] : { col: pac.col(), row: pac.row() };
  },

  _straightOr(options, dir) {
    for (const d of options) if (d === dir) return d;
    return options[0];
  },

  // ---- heatmap ----
  _bumpHeat(col, row) {
    this.heat[row][col] += 1;
    if (this.samples % 300 === 0) {
      for (let r = 0; r < ROWS; r++)
        for (let c = 0; c < COLS; c++) this.heat[r][c] *= 0.85;
    }
  },

  // Hottest walkable tile within Chebyshev radius of (col,row).
  hotTileNear(col, row, rad) {
    let best = null, bestH = 0.5; // require some real history
    for (let dr = -rad; dr <= rad; dr++) {
      for (let dc = -rad; dc <= rad; dc++) {
        const r = row + dr, c = col + dc;
        if (r < 0 || r >= ROWS || c < 0 || c >= COLS) continue;
        if (!Maze.isWalkable(c, r)) continue;
        const h = this.heat[r][c];
        if (h > bestH) { bestH = h; best = { col: c, row: r }; }
      }
    }
    return best;
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
