/* ============================================================
 * input.js — keyboard handling, exposes Input.desired direction
 * ============================================================ */
const Input = {
  desired: DIRS.NONE,   // last requested direction (buffered)
  onDebug: null,        // callback for "G"
  onPause: null,        // callback for "P"
  onStart: null,        // callback for Enter / Space on overlay

  init() {
    window.addEventListener("keydown", (e) => {
      switch (e.code) {
        case "ArrowUp": case "KeyW": this.desired = DIRS.UP; e.preventDefault(); break;
        case "ArrowDown": case "KeyS": this.desired = DIRS.DOWN; e.preventDefault(); break;
        case "ArrowLeft": case "KeyA": this.desired = DIRS.LEFT; e.preventDefault(); break;
        case "ArrowRight": case "KeyD": this.desired = DIRS.RIGHT; e.preventDefault(); break;
        case "KeyG": case "Backquote": if (this.onDebug) this.onDebug(); break;
        case "KeyP": if (this.onPause) this.onPause(); break;
        case "Enter": case "Space":
          if (this.onStart) this.onStart();
          e.preventDefault();
          break;
      }
    });
  },
};
