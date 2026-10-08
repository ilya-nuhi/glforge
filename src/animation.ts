/**
 * Plays a model's glTF animations in the preview.
 *
 * The clock is kept here rather than in the mixer: every step sets the clip's
 * time and has the mixer evaluate that one instant (`update(0)`, which it takes
 * at face value — no looping, clamping or "finished" events). Play, pause, scrub,
 * loop, speed and direction are then plain arithmetic on one number, and a
 * scrubbed pose is exactly the pose playback shows at that time.
 *
 * Stopping hands the model back in the pose the file gives it: the mixer saves
 * every property a clip animates when the clip starts, and puts them back when
 * it stops.
 */
import { AnimationMixer, type AnimationAction, type AnimationClip, type Object3D } from 'three';

/** A clip, as the controls list it. */
export interface ClipInfo {
  name: string;
  /** Seconds: the whole clip, whatever stretch of it plays. */
  duration: number;
}

/** The stretch of a clip that plays — a trim — in the seconds of its own timeline. */
export interface ClipRange {
  start: number;
  end: number;
}

/** Where playback stands, for the controls to show. */
export interface PlaybackState {
  /** The clip posing the model, or null while it stands as the file has it. */
  clip: number | null;
  playing: boolean;
  /** Seconds into the stretch that plays. */
  time: number;
  /** How long that stretch is, in seconds; 0 while nothing is posed. */
  duration: number;
  loop: boolean;
}

/**
 * The most real time one step may cover, in seconds, before the speed scales
 * it. A frame that arrives late — a stalled tab, a slow reload — resumes where
 * playback was rather than jumping.
 */
const MAX_STEP = 0.1;

export class AnimationPlayer {
  private readonly mixer: AnimationMixer;
  private action: AnimationAction | null = null;
  private clip: number | null = null;
  private time = 0;
  private playing = false;
  private loop = true;
  /** Clip seconds per real second. */
  private speed = 1;
  /** Playing from the end towards the start. */
  private reverse = false;
  /** The trimmed clips, by index: only this stretch of each plays. */
  private readonly ranges = new Map<number, ClipRange>();

  /**
   * `clips` in the file's own order, so an index here is an animation index
   * there. `onRest` runs whenever a clip lets go and the model is back in the
   * pose its file gives it — the moment to put anything on it that the clip
   * would otherwise have covered or undone.
   */
  constructor(
    root: Object3D,
    private readonly clips: readonly AnimationClip[],
    private readonly onRest: () => void = () => {},
  ) {
    this.mixer = new AnimationMixer(root);
  }

  list(): ClipInfo[] {
    return this.clips.map((clip) => ({ name: clip.name, duration: clip.duration }));
  }

  state(): PlaybackState {
    return {
      clip: this.clip,
      playing: this.playing,
      time: this.time,
      duration: this.duration(),
      loop: this.loop,
    };
  }

  /** Whether a clip holds the model in anything but the pose the file gives it. */
  isPosed(): boolean {
    return this.action !== null;
  }

  isPlaying(): boolean {
    return this.playing;
  }

  /**
   * Plays a clip: on from where it stands if it is the one posed, else from
   * the top — which, played in reverse, is its end.
   */
  play(index: number): void {
    if (!this.clips[index]) return;
    const top = this.reverse ? this.lengthOf(index) : 0;
    if (index !== this.clip) this.pose(index, top);
    // A clip that does not loop stops at its end (its start, in reverse), and
    // Play there means "again".
    else if (!this.loop && this.atEnd()) this.pose(index, top);
    this.playing = true;
  }

  pause(): void {
    this.playing = false;
  }

  /** Stops playback and puts the model back in the pose the file gives it. */
  stop(): void {
    this.playing = false;
    const action = this.action;
    this.action = null;
    this.clip = null;
    this.time = 0;
    if (!action) return;
    action.stop();
    this.onRest();
  }

  /** Holds the model at one instant of a clip, whether it is playing or not. */
  seek(index: number, time: number): void {
    if (!this.clips[index]) return;
    this.pose(index, time);
  }

  setLoop(loop: boolean): void {
    this.loop = loop;
  }

  /** Clip seconds per real second; a clip playing now carries on at the new pace. */
  setSpeed(speed: number): void {
    this.speed = speed;
  }

  /** Which way time runs; a clip playing now turns round where it stands. */
  setReverse(reverse: boolean): void {
    this.reverse = reverse;
  }

  /**
   * Plays only a stretch of a clip, or all of it again with `null`. A clip
   * posed now stays at the instant it shows, as long as that is still inside.
   */
  setRange(index: number, range: ClipRange | null): void {
    const clip = this.clips[index];
    if (!clip) return;
    const instant = index === this.clip ? this.offset() + this.time : null;
    const start = range ? Math.min(Math.max(range.start, 0), clip.duration) : 0;
    const end = range ? Math.min(Math.max(range.end, start), clip.duration) : clip.duration;
    if (range && (start > 0 || end < clip.duration)) this.ranges.set(index, { start, end });
    else this.ranges.delete(index);
    if (instant !== null && this.action) this.apply(Math.min(Math.max(instant - this.offset(), 0), this.duration()));
  }

  /**
   * Moves playback on by one frame's worth of time. Returns whether anything
   * moved, which is what keeps the viewer drawing.
   */
  advance(seconds: number): boolean {
    if (!this.playing || this.clip === null) return false;
    const duration = this.duration();
    const step = Math.min(Math.max(seconds, 0), MAX_STEP) * this.speed;
    let time = this.reverse ? this.time - step : this.time + step;
    if (this.reverse ? time <= 0 : time >= duration) {
      if (this.loop && duration > 0) {
        // Wraps either way: past the end to the start, or before the start to the end.
        time = ((time % duration) + duration) % duration;
      } else {
        time = this.reverse ? 0 : duration;
        this.playing = false;
      }
    }
    this.apply(time);
    return true;
  }

  /**
   * Evaluates the current instant again, over whatever was just written into
   * the model — so a posed model keeps showing the clip rather than the edit.
   */
  refresh(): void {
    if (this.action) this.apply(this.time);
  }

  dispose(): void {
    this.playing = false;
    this.action = null;
    this.clip = null;
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.mixer.getRoot());
  }

  private duration(): number {
    return this.clip === null ? 0 : this.lengthOf(this.clip);
  }

  /** How long a clip plays for: its trimmed stretch, or all of it. */
  private lengthOf(index: number): number {
    const range = this.ranges.get(index);
    return range ? range.end - range.start : (this.clips[index]?.duration ?? 0);
  }

  /** Where the posed clip's stretch starts in its own timeline. */
  private offset(): number {
    return this.clip === null ? 0 : (this.ranges.get(this.clip)?.start ?? 0);
  }

  /** Whether the clip posed has run out, in the direction it plays. */
  private atEnd(): boolean {
    return this.reverse ? this.time <= 0 : this.time >= this.duration();
  }

  private pose(index: number, time: number): void {
    if (index !== this.clip) {
      // The old clip goes first, so what it animated is back in the file's pose
      // before the new one saves that pose — the one stopping restores.
      if (this.action) {
        this.action.stop();
        this.onRest();
      }
      this.action = this.mixer.clipAction(this.clips[index]);
      this.action.play();
      this.clip = index;
    }
    this.apply(Math.min(Math.max(time, 0), this.duration()));
  }

  private apply(time: number): void {
    this.time = time;
    if (!this.action) return;
    this.action.time = this.offset() + time;
    this.mixer.update(0);
  }
}
