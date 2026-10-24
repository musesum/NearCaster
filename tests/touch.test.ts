import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as d3 from 'd3';
import { pinchTransform, type Pt } from '../src/graph/touch.ts';

const EXTENT: [number, number] = [0.05, 12];
const t0 = d3.zoomIdentity.translate(40, -20).scale(0.6);
const close = (a: number, b: number) => Math.abs(a - b) < 1e-9;

test('two fingers moving together pan by their shift at the same zoom', () => {
  const a0: Pt = [100, 200];
  const b0: Pt = [220, 260];
  const t = pinchTransform(t0, a0, b0, [130, 150], [250, 210], EXTENT);
  assert.ok(close(t.k, t0.k));
  assert.ok(close(t.x - t0.x, 30) && close(t.y - t0.y, -50), `shift ${t.x - t0.x},${t.y - t0.y}`);
});

test('spreading the fingers scales by the distance ratio about their midpoint', () => {
  const a0: Pt = [150, 300];
  const b0: Pt = [250, 300];
  const t = pinchTransform(t0, a0, b0, [100, 300], [300, 300], EXTENT);
  assert.ok(close(t.k, t0.k * 2));
  // The world point under the start midpoint is still under the (unchanged) midpoint.
  const w = t0.invert([200, 300]);
  const [sx, sy] = t.apply(w);
  assert.ok(close(sx, 200) && close(sy, 300), `midpoint ${sx},${sy}`);
});

test('panning and spreading at once keeps the start midpoint under the new midpoint', () => {
  const a0: Pt = [100, 100];
  const b0: Pt = [200, 100];
  const t = pinchTransform(t0, a0, b0, [150, 200], [350, 200], EXTENT);
  assert.ok(close(t.k, t0.k * 2));
  const [sx, sy] = t.apply(t0.invert([150, 100]));
  assert.ok(close(sx, 250) && close(sy, 200), `midpoint ${sx},${sy}`);
});

test('zoom stays inside the extent and survives fingers starting on one spot', () => {
  const t = pinchTransform(t0, [10, 10], [12, 10], [0, 0], [4000, 0], EXTENT);
  assert.equal(t.k, EXTENT[1]);
  const same = pinchTransform(t0, [50, 50], [50, 50], [60, 70], [60, 70], EXTENT);
  assert.ok(close(same.k, t0.k) && Number.isFinite(same.x) && Number.isFinite(same.y));
});

// Gesture state machine against fake pointer streams (no DOM): svg-local == client coordinates here.
import { TouchGestures, HOLD_MS, type TouchHooks } from '../src/graph/touch.ts';

const g = globalThis as unknown as { requestAnimationFrame: (cb: () => void) => unknown; cancelAnimationFrame: (h: unknown) => void };
g.requestAnimationFrame = (cb) => setTimeout(cb, 0);
g.cancelAnimationFrame = (h) => clearTimeout(h as ReturnType<typeof setTimeout>);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function rig() {
  const el = new EventTarget() as EventTarget & { getBoundingClientRect(): { left: number; top: number } };
  el.getBoundingClientRect = () => ({ left: 0, top: 0 });
  const win = new EventTarget();
  const log: string[] = [];
  const hooks: TouchHooks = {
    // Node "n<x>" sits at every x divisible by 100; anything else is background.
    pick: ([x]) => (x % 100 === 0 ? `n${x}` : undefined),
    // The end call carries no point; `lift` marks a clean lift.
    scrub: (id, at, lifted) => log.push(`scrub ${id ?? '-'}${at ? '' : lifted ? ' lift' : ' end'}`),
    tap: (id) => log.push(`tap ${id ?? '-'}`),
    doubleTap: (id) => log.push(`double ${id}`),
    hold: () => (log.push('hold'), d3.zoomIdentity),
    apply: (t) => log.push(`apply k=${t.k.toFixed(2)}`),
    extent: EXTENT,
  };
  new TouchGestures(el as unknown as Element, hooks, win as unknown as Window);
  const fire = (target: EventTarget, type: string, id: number, x: number, y: number, isPrimary: boolean, pointerType = 'touch') =>
    target.dispatchEvent(Object.assign(new Event(type), { pointerId: id, pointerType, isPrimary, clientX: x, clientY: y }));
  return {
    log,
    down: (id: number, x: number, y = 0, primary = true, type?: string) => fire(el, 'pointerdown', id, x, y, primary, type),
    move: (id: number, x: number, y = 0, type?: string) => fire(win, 'pointermove', id, x, y, false, type),
    up: (id: number, x: number, y = 0, type?: string) => fire(win, 'pointerup', id, x, y, false, type),
    cancel: (id: number, x: number, y = 0) => fire(win, 'pointercancel', id, x, y, false),
  };
}

test('a quick tap selects the picked node and never previews', async () => {
  const r = rig();
  r.down(1, 200);
  await sleep(30);
  r.up(1, 203);
  await sleep(HOLD_MS + 30);
  assert.deepEqual(r.log, ['tap n200']);
});

test('holding previews, moving re-picks, and lifting ends the preview without a tap', async () => {
  const r = rig();
  r.down(1, 200);
  await sleep(HOLD_MS + 40);
  r.move(1, 300);
  await sleep(20);
  r.up(1, 300);
  assert.deepEqual(r.log, ['scrub n200', 'scrub n300', 'scrub - lift']);
});

test('a slide past the tap radius previews at once', async () => {
  const r = rig();
  r.down(1, 190);
  r.move(1, 200);
  await sleep(20);
  r.up(1, 200);
  assert.deepEqual(r.log, ['scrub n200', 'scrub - lift']);
});

test('a second finger or a cancel ends the preview without a lift', async () => {
  const r = rig();
  r.down(1, 200);
  await sleep(HOLD_MS + 40);
  r.down(2, 300, 0, false);
  r.up(1, 200);
  r.up(2, 300);
  r.down(3, 400);
  await sleep(HOLD_MS + 40);
  r.cancel(3, 400);
  assert.deepEqual(r.log, ['scrub n200', 'scrub - end', 'hold', 'scrub n400', 'scrub - end']);
});

test('a second tap close by within the window is a double tap on the first node', async () => {
  const r = rig();
  r.down(1, 400);
  r.up(1, 400);
  await sleep(80);
  r.down(2, 410);
  r.up(2, 410);
  assert.deepEqual(r.log, ['tap n400', 'double n400']);
});

test('two fingers pinch and pan the camera, never preview or tap', async () => {
  const r = rig();
  r.down(1, 100);
  r.down(2, 200, 0, false);
  await sleep(10);
  r.move(1, 50);
  r.move(2, 250);
  await sleep(20);
  r.up(1, 50);
  r.up(2, 250);
  await sleep(HOLD_MS + 20);
  assert.deepEqual(r.log, ['hold', 'apply k=2.00']);
});

test('two resting fingers leave the camera alone', async () => {
  const r = rig();
  r.down(1, 100);
  r.down(2, 200, 0, false);
  await sleep(HOLD_MS + 40);
  r.up(1, 100);
  r.up(2, 200);
  assert.deepEqual(r.log, ['hold']);
});

test('a lift that never arrives is forgotten when the next gesture starts', async () => {
  const r = rig();
  r.down(1, 100);
  // Pointer 1 lifts somewhere no listener hears; the next touch is primary again.
  r.down(7, 500);
  r.up(7, 500);
  assert.deepEqual(r.log, ['tap n500']);
});

test('the mouse is not a finger; a pen is', async () => {
  const r = rig();
  r.down(1, 100, 0, true, 'mouse');
  r.up(1, 100, 0, 'mouse');
  r.down(2, 600, 0, true, 'pen');
  r.up(2, 600, 0, 'pen');
  assert.deepEqual(r.log, ['tap n600']);
});
