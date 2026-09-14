// Generates public/icons/*.png with zero image dependencies — a gold crown on a
// felt-green rounded square, plus a maskable variant. Encodes PNG by hand.
// Run: node scripts/build-icons.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePNG(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const mix = (a, b, t) => a + (b - a) * t;
const clamp01 = (v) => Math.max(0, Math.min(1, v));

function inRoundedSquare(x, y, size, radius) {
  const rx = Math.min(radius, size / 2);
  const cx = clamp01ToRange(x, rx, size - rx);
  const cy = clamp01ToRange(y, rx, size - rx);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= rx * rx;
}
function clamp01ToRange(v, lo, hi) {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

// A crown silhouette: a base band + three triangular points, each topped by a small
// ball, drawn as a set of half-plane / circle tests in a size-independent unit square.
function inCrown(ux, uy) {
  // unit square 0..1, crown occupies roughly y in [0.38, 0.72], x in [0.14, 0.86]
  const bandTop = 0.60, bandBot = 0.72;
  if (uy >= bandTop && uy <= bandBot && ux >= 0.14 && ux <= 0.86) return true;

  // three triangular spikes rising from the band
  const spikes = [
    { cx: 0.24, halfW: 0.10, tipY: 0.30 },
    { cx: 0.50, halfW: 0.11, tipY: 0.18 },
    { cx: 0.76, halfW: 0.10, tipY: 0.30 },
  ];
  for (const s of spikes) {
    if (uy < s.tipY || uy > bandTop) continue;
    const t = (uy - bandTop) / (s.tipY - bandTop); // 0 at band, 1 at tip
    const halfWidthHere = s.halfW * (1 - t);
    if (Math.abs(ux - s.cx) <= halfWidthHere) return true;
    // ball at the tip
    const bx = ux - s.cx, by = uy - s.tipY;
    if (bx * bx + by * by <= (s.halfW * 0.55) ** 2) return true;
  }
  return false;
}

function draw(size, maskable) {
  const S = size;
  const buf = Buffer.alloc(S * S * 4);
  const bgInset = maskable ? S * 0.16 : 0; // shrink art for maskable safe zone
  const radius = maskable ? 0 : S * 0.22;

  const feltTop = [10, 61, 42];
  const feltBot = [6, 40, 28];
  const gold1 = [255, 214, 110];
  const gold2 = [201, 150, 40];
  const goldEdge = [120, 84, 20];

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4;
      let r, g, b, a = 255;

      const inBg = maskable ? true : inRoundedSquare(x + 0.5, y + 0.5, S, radius);
      if (!inBg) { buf[i + 3] = 0; continue; }

      const t = y / S;
      r = mix(feltTop[0], feltBot[0], t);
      g = mix(feltTop[1], feltBot[1], t);
      b = mix(feltTop[2], feltBot[2], t);

      // crown art within an inset square
      const ux = (x - bgInset) / (S - 2 * bgInset);
      const uy = (y - bgInset) / (S - 2 * bgInset);
      if (ux >= 0 && ux <= 1 && uy >= 0 && uy <= 1 && inCrown(ux, uy)) {
        const shade = clamp01(1 - Math.abs(ux - 0.5) * 1.4);
        r = mix(gold2[0], gold1[0], shade);
        g = mix(gold2[1], gold1[1], shade);
        b = mix(gold2[2], gold1[2], shade);
      }

      buf[i] = Math.round(r);
      buf[i + 1] = Math.round(g);
      buf[i + 2] = Math.round(b);
      buf[i + 3] = a;
    }
  }
  return buf;
}

mkdirSync('public/icons', { recursive: true });
writeFileSync('public/icons/icon-192.png', encodePNG(192, draw(192, false)));
writeFileSync('public/icons/icon-512.png', encodePNG(512, draw(512, false)));
writeFileSync('public/icons/icon-maskable-512.png', encodePNG(512, draw(512, true)));
console.log('Icons written to public/icons/');
