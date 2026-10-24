// Touch and pen gestures over pointer events: a held or moving finger previews, a tap selects,
// a double tap expands, two fingers zoom and pan. Mouse input stays with d3-zoom and d3-drag.
import * as d3 from 'd3';

export type Pt = [number, number];

export type TouchHooks = {
  // Svg-local point → id of the node under or near the finger (one rule for preview and taps).
  pick(p: Pt): string | undefined;
  // Preview target; `at` is in client coordinates. The end call has no `at`; `lifted` marks a clean lift
  // (not a second finger, a cancel, or a lost lift).
  scrub(id: string | undefined, at?: Pt, lifted?: boolean): void;
  // Tap on a node, or on the background when id is undefined.
  tap(id: string | undefined): void;
  doubleTap(id: string): void;
  // Stops camera motion and returns the transform two fingers start from.
  hold(): d3.ZoomTransform;
  apply(t: d3.ZoomTransform): void;
  extent: [number, number];
};

// A press shorter than HOLD_MS that moves under MOVE_PX is a tap; past either, it previews.
export const HOLD_MS = 250;
export const MOVE_PX = 10;
// A second tap within DOUBLE_MS and DOUBLE_PX of the first is a double tap.
export const DOUBLE_MS = 300;
const DOUBLE_PX = 30;
// Two fingers that have not moved this far leave the camera alone.
const STILL_PX = 1;

const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// Two-finger transform: the world point first under the fingers' midpoint stays under it; spread scales.
export function pinchTransform(t0: d3.ZoomTransform, a0: Pt, b0: Pt, a1: Pt, b1: Pt, extent: [number, number]): d3.ZoomTransform {
  const d0 = dist(a0, b0);
  const d1 = dist(a1, b1);
  const k = Math.max(extent[0], Math.min(extent[1], t0.k * (d0 > 1 ? d1 / d0 : 1)));
  const w = t0.invert([(a0[0] + b0[0]) / 2, (a0[1] + b0[1]) / 2]);
  const m: Pt = [(a1[0] + b1[0]) / 2, (a1[1] + b1[1]) / 2];
  return d3.zoomIdentity.translate(m[0] - k * w[0], m[1] - k * w[1]).scale(k);
}

type Finger = Pick<PointerEvent, 'pointerId' | 'pointerType' | 'isPrimary' | 'clientX' | 'clientY'>;

export class TouchGestures {
  private el: Element;
  private hooks: TouchHooks;
  private pts = new Map<number, Pt>();
  private client = new Map<number, Pt>();
  // The gesture's first finger: a tap candidate until it holds, moves, or a second finger lands.
  private first?: { id: number; p: Pt };
  private pinch?: { ids: [number, number]; t0: d3.ZoomTransform; a0: Pt; b0: Pt };
  private multi = false;
  private scrubbing = false;
  private holdTimer: ReturnType<typeof setTimeout> | undefined;
  private frame = 0;
  private lastTap?: { p: Pt; t: number; id: string | undefined };
  private lastLift = -Infinity;

  constructor(el: Element, hooks: TouchHooks, win: Window = window) {
    this.el = el;
    this.hooks = hooks;
    el.addEventListener('pointerdown', (e) => this.down(e as PointerEvent));
    // Move and lift are heard at window level: a reordered node or a lift outside the svg drops pointer capture.
    win.addEventListener('pointermove', (e) => this.move(e as PointerEvent), { capture: true });
    win.addEventListener('pointerup', (e) => this.up(e as PointerEvent, true), { capture: true });
    win.addEventListener('pointercancel', (e) => this.up(e as PointerEvent, false), { capture: true });
    // Taps are decided here, so the browser's synthetic click, dblclick and mouse events are cancelled.
    el.addEventListener('touchend', (e) => e.preventDefault(), { passive: false });
    // WebKit pinch-zooms the page unless multi-touch moves and its gesture events are cancelled.
    el.addEventListener('touchmove', (e) => (e as TouchEvent).touches.length > 1 && e.preventDefault(), { passive: false });
    el.addEventListener('gesturestart', (e) => e.preventDefault());
    // A long press on an avatar would open the image menu and cancel the preview.
    el.addEventListener('contextmenu', (e) => this.pts.size > 0 && e.preventDefault());
  }

  private finger(e: Finger): boolean {
    return e.pointerType === 'touch' || e.pointerType === 'pen';
  }

  private local(e: Finger): Pt {
    const r = this.el.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  // True for a short while after a finger or pen lifts: the browser's own click/dblclick for it is a duplicate.
  recent(ms = 600): boolean {
    return performance.now() - this.lastLift < ms;
  }

  // Re-picks the preview when the camera or the nodes move under a resting finger.
  refresh(): void {
    if (this.scrubbing) this.schedule();
  }

  private down(e: Finger): void {
    if (!this.finger(e)) return;
    // A desktop pen still sends compatibility mouse events, which would pan through d3-zoom.
    if (e.pointerType === 'pen') (e as PointerEvent).preventDefault?.();
    // Cancelled touchends no longer move focus, so a touch on the graph closes the keyboard itself.
    if (typeof document !== 'undefined' && document.activeElement instanceof HTMLElement) document.activeElement.blur();
    // A primary pointer starts a fresh gesture: anything still tracked is a lift that never arrived.
    if (e.isPrimary && this.pts.size) this.reset();
    this.pts.set(e.pointerId, this.local(e));
    this.client.set(e.pointerId, [e.clientX, e.clientY]);
    if (this.pts.size === 1 && !this.multi) {
      this.first = { id: e.pointerId, p: this.local(e) };
      this.holdTimer = setTimeout(() => this.beginScrub(), HOLD_MS);
      return;
    }
    this.multi = true;
    this.first = undefined;
    clearTimeout(this.holdTimer);
    this.endScrub();
    this.startPinch();
  }

  private move(e: Finger): void {
    if (!this.finger(e) || !this.pts.has(e.pointerId)) return;
    const p = this.local(e);
    this.pts.set(e.pointerId, p);
    this.client.set(e.pointerId, [e.clientX, e.clientY]);
    if (this.first?.id === e.pointerId && !this.scrubbing && dist(p, this.first.p) >= MOVE_PX) this.beginScrub();
    this.schedule();
  }

  private up(e: Finger, lifted: boolean): void {
    if (!this.finger(e) || !this.pts.has(e.pointerId)) return;
    const p = this.local(e);
    // A tap picks where the finger pressed, not where it drifted on lift.
    const tap = lifted && this.pts.size === 1 && !this.multi && !this.scrubbing && this.first?.id === e.pointerId && dist(p, this.first.p) < MOVE_PX ? this.first.p : undefined;
    this.flushNow();
    this.pts.delete(e.pointerId);
    this.client.delete(e.pointerId);
    this.lastLift = performance.now();
    if (this.pts.size === 0) {
      if (lifted) this.endScrub(true);
      this.reset();
      if (tap) this.tapAt(tap);
      return;
    }
    // A lifted pinch finger re-baselines on the two that remain; one finger left does nothing.
    if (this.pinch?.ids.includes(e.pointerId)) this.startPinch();
  }

  private tapAt(p: Pt): void {
    const id = this.hooks.pick(p);
    const now = performance.now();
    const prev = this.lastTap;
    if (prev?.id && now - prev.t < DOUBLE_MS && dist(p, prev.p) < DOUBLE_PX) {
      this.lastTap = undefined;
      this.hooks.doubleTap(prev.id);
      return;
    }
    this.lastTap = { p, t: now, id };
    this.hooks.tap(id);
  }

  private beginScrub(): void {
    clearTimeout(this.holdTimer);
    if (this.multi || this.pts.size !== 1 || this.scrubbing) return;
    this.scrubbing = true;
    this.schedule();
  }

  private endScrub(lifted = false): void {
    if (!this.scrubbing) return;
    this.scrubbing = false;
    this.hooks.scrub(undefined, undefined, lifted);
  }

  private reset(): void {
    clearTimeout(this.holdTimer);
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.pts.clear();
    this.client.clear();
    this.first = undefined;
    this.pinch = undefined;
    this.multi = false;
    this.endScrub();
  }

  private startPinch(): void {
    this.flushNow();
    const ids = [...this.pts.keys()].slice(0, 2);
    if (ids.length < 2) {
      this.pinch = undefined;
      return;
    }
    const [a, b] = ids;
    this.pinch = { ids: [a, b], t0: this.hooks.hold(), a0: this.pts.get(a)!, b0: this.pts.get(b)! };
  }

  // One update per frame: move events can outpace paint.
  private schedule(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.flush();
    });
  }

  // Applies a pending frame before the finger set changes, so content stays under the fingers.
  private flushNow(): void {
    if (!this.frame) return;
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.flush();
  }

  private flush(): void {
    if (this.pinch) {
      const [a, b] = this.pinch.ids;
      const a1 = this.pts.get(a);
      const b1 = this.pts.get(b);
      if (!a1 || !b1 || (dist(a1, this.pinch.a0) < STILL_PX && dist(b1, this.pinch.b0) < STILL_PX)) return;
      this.hooks.apply(pinchTransform(this.pinch.t0, this.pinch.a0, this.pinch.b0, a1, b1, this.hooks.extent));
      return;
    }
    if (!this.scrubbing || !this.first) return;
    const p = this.pts.get(this.first.id);
    if (p) this.hooks.scrub(this.hooks.pick(p), this.client.get(this.first.id));
  }
}
