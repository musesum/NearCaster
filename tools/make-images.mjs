// Writes public/icon.png (1024², no alpha), splash.png (200²), embed.png (1200×800, 3:2).
// Pure Node: an antialiased disc/line rasterizer + zlib PNG encoder.
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const BG = [14, 15, 20];
const PAL = [[138, 99, 210], [86, 180, 233], [230, 159, 0], [0, 158, 115], [204, 121, 167], [240, 228, 66]];

function canvas(w, h) {
  const px = new Float32Array(w * h * 3);
  for (let i = 0; i < w * h; i++) px.set(BG, i * 3);
  return { w, h, px };
}

function blend(c, x, y, rgb, a) {
  if (x < 0 || y < 0 || x >= c.w || y >= c.h || a <= 0) return;
  const i = (y * c.w + x) * 3;
  for (let k = 0; k < 3; k++) c.px[i + k] = c.px[i + k] * (1 - a) + rgb[k] * a;
}

function disc(c, cx, cy, r, rgb, alpha = 1) {
  for (let y = Math.floor(cy - r - 1); y <= Math.ceil(cy + r + 1); y++)
    for (let x = Math.floor(cx - r - 1); x <= Math.ceil(cx + r + 1); x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      blend(c, x, y, rgb, alpha * Math.max(0, Math.min(1, r - d + 0.5)));
    }
}

function line(c, x0, y0, x1, y1, width, rgb, alpha) {
  const minX = Math.floor(Math.min(x0, x1) - width), maxX = Math.ceil(Math.max(x0, x1) + width);
  const minY = Math.floor(Math.min(y0, y1) - width), maxY = Math.ceil(Math.max(y0, y1) + width);
  const dx = x1 - x0, dy = y1 - y0, len2 = dx * dx + dy * dy || 1;
  for (let y = minY; y <= maxY; y++)
    for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5, py = y + 0.5;
      const t = Math.max(0, Math.min(1, ((px - x0) * dx + (py - y0) * dy) / len2));
      const d = Math.hypot(px - (x0 + t * dx), py - (y0 + t * dy));
      blend(c, x, y, rgb, alpha * Math.max(0, Math.min(1, width / 2 - d + 0.5)));
    }
}

// Ego at center, a ring of friends in colored communities, an outer ring of friends-of-friends.
function motif(c, cx, cy, R, seed = 3) {
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const inner = [], outer = [];
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2 + rnd() * 0.2;
    inner.push({ x: cx + Math.cos(a) * R * 0.45, y: cy + Math.sin(a) * R * 0.45, g: Math.floor(i / 3) % PAL.length });
  }
  for (let i = 0; i < 22; i++) {
    const a = (i / 22) * Math.PI * 2 + rnd() * 0.15;
    outer.push({ x: cx + Math.cos(a) * R * (0.82 + rnd() * 0.12), y: cy + Math.sin(a) * R * (0.82 + rnd() * 0.12), g: Math.floor((i / 22) * 4) % PAL.length });
  }
  const lw = Math.max(1.5, R * 0.012);
  for (const n of inner) line(c, cx, cy, n.x, n.y, lw * 1.4, PAL[0], 0.45);
  for (let i = 0; i < inner.length; i++) line(c, inner[i].x, inner[i].y, inner[(i + 1) % inner.length].x, inner[(i + 1) % inner.length].y, lw, [136, 144, 168], 0.35);
  for (const o of outer) {
    const near = inner.map((n) => [Math.hypot(n.x - o.x, n.y - o.y), n]).sort((a, b) => a[0] - b[0]).slice(0, 2);
    for (const [, n] of near) line(c, o.x, o.y, n.x, n.y, lw * 0.8, [136, 144, 168], 0.25);
  }
  for (const o of outer) disc(c, o.x, o.y, R * 0.035, PAL[(o.g + 1) % PAL.length], 0.85);
  for (const n of inner) disc(c, n.x, n.y, R * 0.06, PAL[(n.g + 1) % PAL.length]);
  disc(c, cx, cy, R * 0.15, [255, 224, 128], 0.9);
  disc(c, cx, cy, R * 0.12, PAL[0]);
}

function png(c) {
  const raw = Buffer.alloc((c.w * 3 + 1) * c.h);
  for (let y = 0; y < c.h; y++) {
    raw[y * (c.w * 3 + 1)] = 0;
    for (let x = 0; x < c.w; x++)
      for (let k = 0; k < 3; k++) raw[y * (c.w * 3 + 1) + 1 + x * 3 + k] = Math.round(Math.max(0, Math.min(255, c.px[(y * c.w + x) * 3 + k])));
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let v = n;
    for (let k = 0; k < 8; k++) v = v & 1 ? 0xedb88320 ^ (v >>> 1) : v >>> 1;
    return v >>> 0;
  });
  const crc = (buf) => {
    let v = 0xffffffff;
    for (const b of buf) v = crcTable[(v ^ b) & 0xff] ^ (v >>> 8);
    return (v ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const cr = Buffer.alloc(4);
    cr.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, cr]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(c.w, 0);
  ihdr.writeUInt32BE(c.h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB, no alpha
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

mkdirSync(OUT, { recursive: true });
const icon = canvas(1024, 1024);
motif(icon, 512, 512, 440);
writeFileSync(join(OUT, 'icon.png'), png(icon));
const splash = canvas(200, 200);
motif(splash, 100, 100, 86);
writeFileSync(join(OUT, 'splash.png'), png(splash));
const embed = canvas(1200, 800);
motif(embed, 600, 400, 360, 11);
writeFileSync(join(OUT, 'embed.png'), png(embed));
console.log('wrote icon.png splash.png embed.png to', OUT);
