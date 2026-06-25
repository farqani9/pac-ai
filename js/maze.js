/* ============================================================
 * maze.js — board layout, tile helpers, pellet state, rendering
 * Shared globals: TILE, COLS, ROWS, DIRS, Maze
 * ============================================================ */

const TILE = 20; // pixels per tile

// Legend:
//   #  wall            (blocks everyone)
//   .  pellet          (walkable, +10)
//   o  power pellet    (walkable, +50, frightens ghosts)
//   ' ' empty path     (walkable, no pellet — tunnel mouths & ghost lobby)
//   =  ghost-house door (walkable only by ghosts entering/leaving)
const MAZE_SRC = [
  "############################", // 0
  "#............##............#", // 1
  "#.####.#####.##.#####.####.#", // 2
  "#o####.#####.##.#####.####o#", // 3
  "#.####.#####.##.#####.####.#", // 4
  "#..........................#", // 5
  "#.####.##.########.##.####.#", // 6
  "#.####.##.########.##.####.#", // 7
  "#......##....##....##......#", // 8
  "######.##### ## #####.######", // 9
  "     #.##### ## #####.#     ", // 10
  "     #.##          ##.#     ", // 11  ghost lobby (above door)
  "     #.## ###==### ##.#     ", // 12  door at cols 13-14
  "     #.## #      # ##.#     ", // 13  house interior
  "######.## #      # ##.######", // 14
  "      .   #      #   .      ", // 15  TUNNEL row (open edges)
  "######.## #      # ##.######", // 16
  "     #.## ######## ##.#     ", // 17  house floor
  "     #.##          ##.#     ", // 18
  "     #.##### ## #####.#     ", // 19
  "######.##### ## #####.######", // 20
  "#............##............#", // 21
  "#.####.#####.##.#####.####.#", // 22
  "#.####.#####....#####.####.#", // 23  Pac-Man start corridor (center)
  "#o.....##....##....##.....o#", // 24
  "###.##.##.########.##.##.###", // 25
  "#......##....##....##......#", // 26
  "#.##########.##.##########.#", // 27
  "#..........................#", // 28
  "############################", // 29
];

const ROWS = MAZE_SRC.length;
const COLS = MAZE_SRC[0].length;

// Direction vectors (cx/cy in tile units). NONE = standing still.
const DIRS = {
  NONE:  { x:  0, y:  0, name: "NONE"  },
  UP:    { x:  0, y: -1, name: "UP"    },
  DOWN:  { x:  0, y:  1, name: "DOWN"  },
  LEFT:  { x: -1, y:  0, name: "LEFT"  },
  RIGHT: { x:  1, y:  0, name: "RIGHT" },
};
const MOVE_DIRS = [DIRS.UP, DIRS.LEFT, DIRS.DOWN, DIRS.RIGHT]; // classic tie-break order
function opposite(d) {
  if (d === DIRS.UP) return DIRS.DOWN;
  if (d === DIRS.DOWN) return DIRS.UP;
  if (d === DIRS.LEFT) return DIRS.RIGHT;
  if (d === DIRS.RIGHT) return DIRS.LEFT;
  return DIRS.NONE;
}

const Maze = {
  width: COLS * TILE,
  height: ROWS * TILE,

  // Mutable pellet grid: 0 none, 1 pellet, 2 power pellet.
  pellets: [],
  pelletsLeft: 0,
  totalPellets: 0,

  // Key tiles (filled in by computePositions()).
  pacStart: { col: 13, row: 23 },
  doorTiles: [{ col: 13, row: 12 }, { col: 14, row: 12 }],
  houseExit: { col: 13, row: 11 },   // lobby tile just above the door
  houseCenter: { col: 13, row: 14 }, // inside the house

  reset() {
    this.pellets = [];
    this.pelletsLeft = 0;
    for (let r = 0; r < ROWS; r++) {
      const row = [];
      for (let c = 0; c < COLS; c++) {
        const ch = MAZE_SRC[r][c];
        if (ch === ".") { row.push(1); this.pelletsLeft++; }
        else if (ch === "o") { row.push(2); this.pelletsLeft++; }
        else row.push(0);
      }
      this.pellets.push(row);
    }
    // Pac-Man starts on an empty tile.
    this.pellets[this.pacStart.row][this.pacStart.col] = 0;
    this.totalPellets = this.pelletsLeft;
  },

  charAt(col, row) {
    if (row < 0 || row >= ROWS || col < 0 || col >= COLS) return "#";
    return MAZE_SRC[row][col];
  },

  isWall(col, row) {
    return this.charAt(col, row) === "#";
  },
  isDoor(col, row) {
    return this.charAt(col, row) === "=";
  },

  // Walkable for Pac-Man: anything that isn't a wall or a door.
  isWalkable(col, row) {
    const ch = this.charAt(col, row);
    return ch !== "#" && ch !== "=";
  },

  // Walkable for a ghost. Ghosts may use the door only while in a
  // house transition state (leaving / entering / eaten).
  ghostWalkable(col, row, canUseDoor) {
    const ch = this.charAt(col, row);
    if (ch === "#") return false;
    if (ch === "=") return !!canUseDoor;
    return true;
  },

  isTunnelRow(row) {
    // A tile column at the very edge that is walkable marks a tunnel row.
    return this.isWalkable(0, row) || this.isWalkable(COLS - 1, row);
  },

  // Pellet interaction. Returns 0 (nothing), 1 (pellet), 2 (power).
  eat(col, row) {
    const v = this.pellets[row][col];
    if (v !== 0) {
      this.pellets[row][col] = 0;
      this.pelletsLeft--;
    }
    return v;
  },

  cleared() { return this.pelletsLeft <= 0; },

  // -------- rendering --------
  drawWalls(ctx) {
    ctx.save();
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const ch = MAZE_SRC[r][c];
        if (ch === "#") this._wallTile(ctx, c, r);
        else if (ch === "=") this._doorTile(ctx, c, r);
      }
    }
    ctx.restore();
  },

  _wallTile(ctx, c, r) {
    const x = c * TILE, y = r * TILE;
    const inset = 3;
    // Only draw a wall block if it borders a non-wall tile, so the
    // solid interiors stay dark and the maze reads as neon outlines.
    const neighbours = [
      this.isWall(c, r - 1), this.isWall(c, r + 1),
      this.isWall(c - 1, r), this.isWall(c + 1, r),
      this.isWall(c - 1, r - 1), this.isWall(c + 1, r - 1),
      this.isWall(c - 1, r + 1), this.isWall(c + 1, r + 1),
    ];
    const surrounded = neighbours.every(Boolean);
    if (surrounded) return;

    ctx.fillStyle = "#11163a";
    ctx.fillRect(x, y, TILE, TILE);
    ctx.strokeStyle = "#2a3bff";
    ctx.lineWidth = 2;
    ctx.shadowColor = "#2a3bff";
    ctx.shadowBlur = 6;
    roundRect(ctx, x + inset, y + inset, TILE - inset * 2, TILE - inset * 2, 5);
    ctx.stroke();
    ctx.shadowBlur = 0;
  },

  _doorTile(ctx, c, r) {
    const x = c * TILE, y = r * TILE;
    ctx.fillStyle = "#ff7bd5";
    ctx.fillRect(x, y + TILE / 2 - 2, TILE, 4);
  },

  drawPellets(ctx, time) {
    ctx.save();
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const v = this.pellets[r][c];
        if (v === 0) continue;
        const cx = c * TILE + TILE / 2;
        const cy = r * TILE + TILE / 2;
        if (v === 1) {
          ctx.fillStyle = "#ffd9b0";
          ctx.beginPath();
          ctx.arc(cx, cy, 2.2, 0, Math.PI * 2);
          ctx.fill();
        } else {
          const pulse = 4 + Math.sin(time / 180) * 1.6;
          ctx.fillStyle = "#ffe600";
          ctx.shadowColor = "#ffe600";
          ctx.shadowBlur = 10;
          ctx.beginPath();
          ctx.arc(cx, cy, pulse, 0, Math.PI * 2);
          ctx.fill();
          ctx.shadowBlur = 0;
        }
      }
    }
    ctx.restore();
  },
};

// Small canvas helper, shared.
function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// Geometry helpers shared by entities.
function tileCenter(idx) { return idx * TILE + TILE / 2; }
function tileOf(px) { return Math.floor(px / TILE); }
function atCenter(px) { return ((px % TILE) + TILE) % TILE === TILE / 2; }
