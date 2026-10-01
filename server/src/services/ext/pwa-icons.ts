/**
 * Dependency-free PNG icon generator for the installable web app (manifest icons + apple-touch-icon).
 * Draws the brand mark (accent rounded square + check) with 4x4 supersampling and encodes RGBA PNG via zlib.
 * Regenerate the committed files with:  npx tsx server/src/services/ext/pwa-icons.ts
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ACCENT: [number, number, number] = [0x25, 0x6a, 0xbf]; // --accent in web/src/index.css (same in light and dark)
export const ICONS = [
  { file: 'icon-192.png', size: 192, maskable: false },
  { file: 'icon-512.png', size: 512, maskable: false },
  { file: 'icon-maskable-512.png', size: 512, maskable: true },
  { file: 'apple-touch-icon.png', size: 180, maskable: true }, // iOS applies its own rounding: draw full-bleed
];

// Check mark from the favicon, in a 32-unit box (stroke width 3, round caps).
const CHECK: [number, number][] = [[9, 16.5], [13.5, 21], [23, 11.5]];

function segDist(px: number, py: number, [ax, ay]: [number, number], [bx, by]: [number, number]) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function inRoundRect(x: number, y: number, r: number) {
  const cx = Math.min(Math.max(x, r), 32 - r), cy = Math.min(Math.max(y, r), 32 - r);
  return Math.hypot(x - cx, y - cy) <= r;
}

/** Raw PNG scanlines (filter byte 0 + RGBA) for one icon. */
export function renderScanlines(size: number, maskable: boolean): Buffer {
  const out = Buffer.alloc(size * (size * 4 + 1));
  const S = 4; const unit = 32 / size;
  // Maskable icons keep the mark inside the 80% safe zone; scale it down slightly around the centre.
  const scale = maskable ? 0.82 : 1;
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    out[row] = 0;
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) {
        const ux = (x + (sx + 0.5) / S) * unit, uy = (y + (sy + 0.5) / S) * unit;
        if (!maskable && !inRoundRect(ux, uy, 7)) continue;
        const mx = 16 + (ux - 16) / scale, my = 16 + (uy - 16) / scale;
        const onCheck = segDist(mx, my, CHECK[0], CHECK[1]) <= 1.5 || segDist(mx, my, CHECK[1], CHECK[2]) <= 1.5;
        const [cr, cg, cb] = onCheck ? [255, 255, 255] : ACCENT;
        r += cr; g += cg; b += cb; a += 1;
      }
      const o = row + 1 + x * 4;
      if (a) { out[o] = Math.round(r / a); out[o + 1] = Math.round(g / a); out[o + 2] = Math.round(b / a); }
      out[o + 3] = Math.round((a / (S * S)) * 255);
    }
  }
  return out;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function crc32(buf: Buffer) { let c = 0xffffffff; for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type: string, data: Buffer) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

export function encodePng(size: number, scanlines: Buffer) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(scanlines, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

export const ICON_DIR = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../../web/public/icons');

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  mkdirSync(ICON_DIR, { recursive: true });
  for (const i of ICONS) writeFileSync(resolve(ICON_DIR, i.file), encodePng(i.size, renderScanlines(i.size, i.maskable)));
  console.log(`Wrote ${ICONS.length} icons to ${ICON_DIR}`);
}
