/**
 * Playback clock for the timelapse: turns elapsed time into a position in the log.
 *
 * It owns the page's only timer (one animation frame while playing, none while paused), so
 * "is anything still running?" has one answer: `dispose()` cancels it and nothing else can
 * schedule another. The scheduler and clock are injected so tests can drive them.
 */

export interface FrameScheduler {
  request(callback: () => void): number;
  cancel(handle: number): void;
}

export interface PlayerOptions {
  /** Positions run 0..length. */
  length: number;
  /** Paints a second at 1×. */
  rate: number;
  onFrame(position: number): void;
  onState?(playing: boolean): void;
  scheduler?: FrameScheduler;
  now?: () => number;
}

export interface Player {
  readonly playing: boolean;
  readonly position: number;
  play(): void;
  pause(): void;
  toggle(): void;
  /** Jump to a position (clamped). Does not change whether it is playing. */
  seek(position: number): void;
  setSpeed(multiplier: number): void;
  dispose(): void;
}

/** A tab that was asleep must not leap through the log when it wakes. */
const MAX_STEP_MS = 100;

export const browserScheduler: FrameScheduler = {
  request: (callback) => window.requestAnimationFrame(callback),
  cancel: (handle) => window.cancelAnimationFrame(handle),
};

/**
 * Paints a second at 1×: fast enough that the whole log plays in about a minute and a half
 * however long it is, never slower than a stroke or two a second.
 */
export function baseRate(length: number): number {
  return Math.max(30, Math.ceil(length / 90));
}

export function createPlayer(options: PlayerOptions): Player {
  const scheduler = options.scheduler ?? browserScheduler;
  const now = options.now ?? (() => performance.now());
  const length = Math.max(0, options.length);
  let position = 0;
  let speed = 1;
  let playing = false;
  let disposed = false;
  let handle: number | null = null;
  let last = 0;

  function clamp(value: number): number {
    return Math.min(length, Math.max(0, Number.isNaN(value) ? 0 : value));
  }

  function stop(): void {
    if (handle !== null) scheduler.cancel(handle);
    handle = null;
    if (playing) {
      playing = false;
      options.onState?.(false);
    }
  }

  function tick(): void {
    handle = null;
    if (!playing || disposed) return;
    const t = now();
    const dt = Math.min(MAX_STEP_MS, Math.max(0, t - last));
    last = t;
    position = clamp(position + (dt / 1000) * options.rate * speed);
    options.onFrame(Math.floor(position));
    if (position >= length) {
      stop();
      return;
    }
    handle = scheduler.request(tick);
  }

  return {
    get playing() {
      return playing;
    },
    get position() {
      return Math.floor(position);
    },
    play() {
      if (disposed || playing || length === 0) return;
      // Play at the end starts over.
      if (position >= length) {
        position = 0;
        options.onFrame(0);
      }
      playing = true;
      last = now();
      options.onState?.(true);
      handle = scheduler.request(tick);
    },
    pause() {
      stop();
    },
    toggle() {
      if (playing) stop();
      else this.play();
    },
    seek(target) {
      if (disposed) return;
      position = clamp(target);
      options.onFrame(Math.floor(position));
    },
    setSpeed(multiplier) {
      if (Number.isFinite(multiplier) && multiplier > 0) speed = multiplier;
    },
    dispose() {
      stop();
      disposed = true;
    },
  };
}
