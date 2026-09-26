/**
 * The bar's mood critter: a small round creature whose animation reflects the quota.
 *
 * Drawn procedurally on a canvas rather than shipped as a GIF or sprite sheet. Three reasons:
 *
 *  - It can react. A looping GIF cannot know the quota, so a static animation would contradict the
 *    numbers right next to it. Here the mood is driven by the same traffic level as the bars.
 *  - No binary assets, no encoder, no palette limits, and it scales cleanly to any DPI.
 *  - Cheap: a few dozen path operations per frame at 24fps, and `requestAnimationFrame` stops
 *    entirely while the window is hidden.
 *
 * Loaded as a classic `<script src="creature.js">` before `bar.js`, which then calls
 * `window.cuwCreateCritter(canvas)`.
 *
 * The creature is an original design, not any existing character.
 */

(() => {
  type Mood = "ok" | "warn" | "alert" | "critical" | "spent" | "sleep";

  interface Critter {
    setMood: (mood: Mood) => void;
    start: () => void;
    stop: () => void;
  }

  interface MoodParams {
    /** Vertical hop amplitude, in canvas units. */
    bounce: number;
    /** Hops per second. */
    cycle: number;
    /** Body tilt and ear swing amplitude. */
    lean: number;
    /** Seconds between blinks. Zero disables blinking entirely. */
    blink: number;
    /** High-frequency positional shake amplitude. */
    jitter: number;
    /** Sweat drops per second. Zero disables sweat. */
    sweat: number;
    panting: boolean;
    /** Wide eyes, raised brows and a gaping mouth. */
    alarmed: boolean;
    asleep: boolean;
    /** Body colour shift toward the alert colour. */
    tint: number;
    /** Alarm mark drawn beside the creature, or null for none. */
    mark: null | "one" | "two";
  }

  const PALETTE = {
    body: "#8ea4cc",
    bodyShade: "#6b7fa8",
    belly: "#ccd7ec",
    earInner: "#e6b3c6",
    eye: "#ffffff",
    pupil: "#1d212b",
    mouth: "#3b2430",
    tongue: "#e8809a",
    sweat: "#63c0f7",
    alarm: "#f85149",
    zz: "#8b94a5",
    outline: "#2a3040",
  };

  /** Frames per second. Capped low: this is an always-on-top window, it should stay cheap. */
  const FPS = 24;
  const FRAME_MS = 1000 / FPS;

  const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

  function ellipse(ctx: CanvasRenderingContext2D, x: number, y: number, rx: number, ry: number, fill: string): void {
    ctx.beginPath();
    ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
    ctx.fillStyle = fill;
    ctx.fill();
  }

  function createCritter(canvas: HTMLCanvasElement): Critter {
    const maybeCtx = canvas.getContext("2d");
    if (maybeCtx === null) {
      // No canvas support: the bars alone still convey the quota.
      return { setMood: () => undefined, start: () => undefined, stop: () => undefined };
    }
    // Bind to a non-nullable const: narrowing on `maybeCtx` does not reach the hoisted helper
    // functions below, but a declared non-null type does.
    const ctx: CanvasRenderingContext2D = maybeCtx;

    let mood: Mood = "sleep";
    let raf = 0;
    let last = 0;
    let elapsed = 0;

    /** Crisp on any display scale. */
    function resize(): number {
      const dpr = window.devicePixelRatio || 1;
      const size = canvas.clientWidth || 46;
      const px = Math.round(size * dpr);
      if (canvas.width !== px || canvas.height !== px) {
        canvas.width = px;
        canvas.height = px;
      }
      return px;
    }

    /* ------------------------------ mood parameters ------------------------------ */

    /**
     * Everything that varies by mood, in one place. `alert` is a high bar, `critical` is the
     * "almost out" state just below it, and `spent` is what an actually rate-limited account looks
     * like - a creature that has given up rather than one still fighting.
     */
    function moodParams(m: Mood): MoodParams {
      switch (m) {
        case "ok":
          return { bounce: 0.085, cycle: 2.4, lean: 0.05, blink: 3.4, jitter: 0, sweat: 0, panting: false, alarmed: false, asleep: false, tint: 0, mark: null };
        case "warn":
          return { bounce: 0.045, cycle: 1.5, lean: 0.03, blink: 2.4, jitter: 0, sweat: 0.35, panting: false, alarmed: false, asleep: false, tint: 0.35, mark: null };
        case "alert":
          return { bounce: 0.03, cycle: 3.2, lean: 0.02, blink: 1.4, jitter: 0, sweat: 1.5, panting: true, alarmed: false, asleep: false, tint: 0.75, mark: "one" };
        case "critical":
          // Nearly out: frantic, wide-eyed, and visibly panicking rather than merely uncomfortable.
          return { bounce: 0.022, cycle: 6.4, lean: 0.1, blink: 0, jitter: 0.03, sweat: 2.6, panting: true, alarmed: true, asleep: false, tint: 0.92, mark: "two" };
        case "spent":
          return { bounce: 0.012, cycle: 0.7, lean: 0.015, blink: 0.9, jitter: 0, sweat: 1.1, panting: true, alarmed: false, asleep: false, tint: 1, mark: "one" };
        default:
          return { bounce: 0.03, cycle: 0.55, lean: 0, blink: 0, jitter: 0, sweat: 0, panting: false, alarmed: false, asleep: true, tint: 0, mark: null };
      }
    }

    /* --------------------------------- drawing ---------------------------------- */

    function draw(now: number): void {
      const size = resize();
      const p = moodParams(mood);

      // Advance on a fixed timestep so the animation speed does not depend on the display refresh
      // rate or on how long the frame took.
      const delta = last === 0 ? 0 : Math.min(now - last, 250);
      last = now;
      elapsed += delta;

      const t = elapsed / 1000;
      const hop = Math.sin(t * p.cycle * Math.PI * 2);
      const bob = hop * p.bounce;
      // Ears trail the body, so they swing half a beat behind.
      const earSwing = Math.sin((t * p.cycle - 0.25) * Math.PI * 2) * p.lean;

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, size, size);
      // Work in a 0..1 space scaled to the canvas.
      ctx.scale(size, size);

      // Ground shadow: sells the hop without needing a floor.
      const shadowW = 0.26 - bob * 0.5;
      ctx.globalAlpha = 0.28 - bob * 0.9;
      ellipse(ctx, 0.5, 0.9, Math.max(0.08, shadowW), 0.028, "#000000");
      ctx.globalAlpha = 1;

      ctx.save();
      // High-frequency shake for the "almost out" mood. Two incommensurate frequencies so the
      // motion never visibly loops.
      const jx = Math.sin(t * 41) * p.jitter;
      const jy = Math.sin(t * 53) * p.jitter * 0.6;
      ctx.translate(0.5 + jx, 0.62 - bob + jy);
      ctx.rotate(Math.sin(t * p.cycle * Math.PI * 2) * p.lean * 0.35 + jx * 0.8);

      drawEar(ctx, -1, earSwing);
      drawEar(ctx, 1, -earSwing);

      // Body. The tint shifts toward the alarm red as things get bad, so a nearly-exhausted account
      // looks flushed rather than just "bluer".
      ellipse(ctx, 0, 0, 0.33, 0.3, mix(PALETTE.body, PALETTE.alarm, p.tint * 0.3));
      // Belly.
      ellipse(ctx, 0, 0.07, 0.23, 0.2, mix(PALETTE.belly, "#ffffff", 0));
      // Cheeks.
      ctx.globalAlpha = 0.5;
      ellipse(ctx, -0.19, 0.045, 0.055, 0.035, PALETTE.earInner);
      ellipse(ctx, 0.19, 0.045, 0.055, 0.035, PALETTE.earInner);
      ctx.globalAlpha = 1;

      // Tuft on the head, springs with the hop.
      ctx.beginPath();
      ctx.moveTo(-0.02, -0.27);
      ctx.quadraticCurveTo(0.01, -0.36 - bob * 0.5, 0.05, -0.29);
      ctx.quadraticCurveTo(0.02, -0.26, 0.02, -0.24);
      ctx.fillStyle = PALETTE.bodyShade;
      ctx.fill();

      drawFace(ctx, t, p);
      drawFeet(ctx, hop);

      ctx.restore();

      if (p.asleep) drawSleepZs(ctx, t);
      if (p.sweat > 0) drawSweat(ctx, t, p.sweat);
      if (p.mark !== null) drawAlarmMark(ctx, t, p);
    }

    function drawEar(c: CanvasRenderingContext2D, side: number, swing: number): void {
      c.save();
      c.translate(side * 0.19, -0.2);
      c.rotate(side * 0.35 + swing * side);
      c.beginPath();
      c.ellipse(0, -0.1, 0.085, 0.16, 0, 0, Math.PI * 2);
      c.fillStyle = mix(PALETTE.body, PALETTE.alarm, moodParams(mood).tint * 0.3);
      c.fill();
      c.beginPath();
      c.ellipse(0, -0.11, 0.045, 0.1, 0, 0, Math.PI * 2);
      c.fillStyle = PALETTE.earInner;
      c.globalAlpha = 0.75;
      c.fill();
      c.restore();
    }

    function drawFace(c: CanvasRenderingContext2D, t: number, p: MoodParams): void {
      const eyeY = -0.04;
      const eyeDx = 0.115;
      const blinkCycle = p.blink > 0 ? t % p.blink : 999;
      const blinking = p.blink > 0 && blinkCycle < 0.14;
      const look = clamp(hopOffset(t, p.cycle) * 0.02, -0.02, 0.02);

      for (const side of [-1, 1]) {
        const x = side * eyeDx;

        if (p.alarmed) {
          // Wide whites with pinprick pupils, plus a raised brow: the "we are about to be cut off"
          // expression.
          ellipse(c, x, eyeY, 0.078, 0.086, PALETTE.eye);
          ellipse(c, x + look * 0.4, eyeY + 0.004, 0.021, 0.026, PALETTE.pupil);
          c.beginPath();
          c.moveTo(x - side * 0.05, eyeY - 0.1);
          c.lineTo(x + side * 0.07, eyeY - 0.135);
          c.strokeStyle = PALETTE.outline;
          c.lineWidth = 0.02;
          c.lineCap = "round";
          c.stroke();
          continue;
        }

        if (p.asleep || blinking) {
          // Closed eye: a downward curve.
          c.beginPath();
          c.moveTo(x - 0.055, eyeY);
          c.quadraticCurveTo(x, eyeY + (p.asleep ? 0.045 : 0.03), x + 0.055, eyeY);
          c.strokeStyle = PALETTE.outline;
          c.lineWidth = 0.022;
          c.lineCap = "round";
          c.stroke();
          continue;
        }

        ellipse(c, x, eyeY, 0.062, 0.068, PALETTE.eye);
        // Pupil drifts slightly with the bounce, which makes it feel alive.
        ellipse(c, x + look, eyeY + 0.006, 0.03, 0.034, PALETTE.pupil);
        ellipse(c, x + look - 0.011, eyeY - 0.012, 0.011, 0.012, "rgba(255,255,255,0.9)");
      }

      // Mouth.
      if (p.alarmed) {
        // Gaping, with a quick gulp.
        const gasp = 0.5 + 0.5 * Math.sin(t * 11);
        ellipse(c, 0, 0.12, 0.058, 0.04 + gasp * 0.022, PALETTE.mouth);
        ellipse(c, 0, 0.135 + gasp * 0.012, 0.032, 0.022 + gasp * 0.01, PALETTE.tongue);
      } else if (p.panting) {
        // Open, panting, with a tongue.
        const pant = 0.5 + 0.5 * Math.sin(t * 9);
        ellipse(c, 0, 0.115, 0.045, 0.03 + pant * 0.018, PALETTE.mouth);
        ellipse(c, 0, 0.128 + pant * 0.008, 0.028, 0.014 + pant * 0.008, PALETTE.tongue);
      } else if (p.asleep) {
        ellipse(c, 0, 0.108, 0.03, 0.022, PALETTE.mouth);
      } else {
        c.beginPath();
        c.moveTo(-0.035, 0.1);
        c.quadraticCurveTo(0, 0.125, 0.035, 0.1);
        c.strokeStyle = PALETTE.mouth;
        c.lineWidth = 0.02;
        c.lineCap = "round";
        c.stroke();
      }
    }

    function drawFeet(c: CanvasRenderingContext2D, hop: number): void {
      // Feet alternate opposite the body, so the creature reads as running in place.
      const swing = Math.sin(hop * Math.PI) * 0.03;
      for (const side of [-1, 1]) {
        c.save();
        c.translate(side * 0.13, 0.27);
        c.rotate(side * swing * 2);
        ellipse(c, 0, 0, 0.062, 0.04, PALETTE.bodyShade);
        c.restore();
      }
    }

    function drawSleepZs(c: CanvasRenderingContext2D, t: number): void {
      c.save();
      c.fillStyle = PALETTE.zz;
      c.font = "0.14px sans-serif";
      c.textAlign = "center";
      for (let i = 0; i < 3; i += 1) {
        const phase = (t * 0.5 + i * 0.33) % 1;
        c.globalAlpha = 0.75 * (1 - phase);
        c.fillText("z", 0.72 + phase * 0.16, 0.5 - phase * 0.42);
      }
      c.restore();
    }

    function drawSweat(c: CanvasRenderingContext2D, t: number, rate: number): void {
      c.save();
      c.fillStyle = PALETTE.sweat;
      // Sized for the real 48px widget: a teardrop drawn to scale here would land under 3px and be
      // invisible, so it is deliberately oversized and fewer are drawn.
      const count = Math.max(1, Math.round(rate * 1.6));
      for (let i = 0; i < count; i += 1) {
        const phase = (t * rate + i / count) % 1;
        const side = i % 2 === 0 ? 1 : -1;
        const x = side * (0.31 + phase * 0.06);
        const y = 0.3 + phase * 0.55;
        c.globalAlpha = 0.9 * (1 - phase * 0.6);
        c.beginPath();
        // Teardrop: a circle with a point on top.
        c.moveTo(x, y - 0.085);
        c.quadraticCurveTo(x + 0.042, y + 0.014, x, y + 0.032);
        c.quadraticCurveTo(x - 0.042, y + 0.014, x, y - 0.085);
        c.fill();
      }
      c.restore();
    }

    function drawAlarmMark(c: CanvasRenderingContext2D, t: number, p: MoodParams): void {
      // A pulsing mark beside the creature so a nearly-exhausted account is obvious at a glance.
      // "!!" in red for the almost-out mood, a single cooler mark for merely high usage.
      const urgent = p.mark === "two";
      const pulse = 0.55 + 0.45 * Math.sin(t * (urgent ? 8 : 6));
      c.save();
      c.globalAlpha = pulse;
      c.fillStyle = urgent ? PALETTE.alarm : PALETTE.sweat;
      c.textAlign = "center";
      c.font = `bold ${urgent ? 0.24 : 0.22}px sans-serif`;
      c.fillText(urgent ? "!!" : "!", 0.88, urgent ? 0.2 : 0.22);
      c.restore();
    }

    /* ------------------------------ colour helpers ------------------------------ */

    function hexToRgb(hex: string): [number, number, number] {
      const v = parseInt(hex.slice(1), 16);
      return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
    }

    function mix(a: string, b: string, amount: number): string {
      const t = clamp(amount, 0, 1);
      const [r1, g1, b1] = hexToRgb(a);
      const [r2, g2, b2] = hexToRgb(b);
      const mixChannel = (x: number, y: number): number => Math.round(x + (y - x) * t);
      return `rgb(${mixChannel(r1, r2)}, ${mixChannel(g1, g2)}, ${mixChannel(b1, b2)})`;
    }

    function hopOffset(t: number, cycle: number): number {
      return Math.sin(t * cycle * Math.PI * 2);
    }

    /* ------------------------------- frame loop --------------------------------- */

    function loop(now: number): void {
      raf = requestAnimationFrame(loop);
      // Throttle to FPS; the browser may call back much faster on a high-refresh display.
      if (now - last < FRAME_MS) return;
      draw(now);
    }

    return {
      setMood(next: Mood): void {
        mood = next;
      },
      start(): void {
        if (raf !== 0) return;
        last = 0;
        raf = requestAnimationFrame(loop);
      },
      stop(): void {
        if (raf === 0) return;
        cancelAnimationFrame(raf);
        raf = 0;
      },
    };
  }

  // Exposed on `window` because this is a classic script: it cannot export, and `bar.js` is a
  // separate file that needs a handle on it.
  (window as unknown as { cuwCreateCritter: (canvas: HTMLCanvasElement) => Critter }).cuwCreateCritter = createCritter;
})();
