/**
 * Generates the tray icons as PNGs.
 *
 * Electron needs real image files for the tray, and adding a raster dependency for three 16x16
 * glyphs is not worth it, so this writes minimal 8-bit RGBA PNGs directly using zlib. Run with
 * `node scripts/make-icons.mjs` after changing the palette.
 */
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "assets");

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  // 10..12 stay zero: deflate, adaptive filtering, no interlace.

  // One filter byte (0 = None) per scanline.
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// One colour per state so the tray reads at a glance; these match `--ok/--warn/--alert` in shared.css.
const VARIANTS = {
  tray: { top: [0x3f, 0xb9, 0x50], bottom: [0x3f, 0xb9, 0x50] },
  "tray-warn": { top: [0xd2, 0x99, 0x22], bottom: [0xd2, 0x99, 0x22] },
  "tray-muted": { top: [0x6b, 0x74, 0x82], bottom: [0x4b, 0x55, 0x63] },
  "tray-alert": { top: [0xf8, 0x51, 0x49], bottom: [0xf8, 0x51, 0x49] },
};

function drawGlyph(size) {
  const rgba = Buffer.alloc(size * size * 4, 0);
  const unit = size / 16;
  // Two rounded bars: the 5h window and the 7d window, matching the widget itself.
  const bars = [
    { y0: 4, y1: 7, color: VARIANTS.tray.top },
    { y0: 9, y1: 12, color: VARIANTS.tray.bottom },
  ];

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const px = x + 0.5;
      const py = y + 0.5;
      let color = null;
      for (const bar of bars) {
        const left = 2 * unit;
        const right = 14 * unit;
        const top = bar.y0 * unit;
        const bottom = bar.y1 * unit;
        if (px >= left && px <= right && py >= top && py <= bottom) {
          color = bar.color;
          break;
        }
      }
      if (color === null) continue;
      const offset = (y * size + x) * 4;
      rgba[offset] = color[0];
      rgba[offset + 1] = color[1];
      rgba[offset + 2] = color[2];
      rgba[offset + 3] = 255;
    }
  }
  return rgba;
}

function drawVariant(size, variant) {
  const base = drawGlyph(size);
  // Recolour every opaque pixel to this variant's palette, keeping the anti-aliased alpha.
  const rgba = Buffer.from(base);
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] === 0) continue;
    // The top bar occupies the upper half of the glyph.
    const palette = i / 4 < size * size * 0.5 ? variant.top : variant.bottom;
    rgba[i] = palette[0];
    rgba[i + 1] = palette[1];
    rgba[i + 2] = palette[2];
  }
  return rgba;
}

mkdirSync(outDir, { recursive: true });

for (const [name, variant] of Object.entries(VARIANTS)) {
  writeFileSync(join(outDir, `${name}.png`), encodePng(16, 16, drawVariant(16, variant)));
  writeFileSync(join(outDir, `${name}@2x.png`), encodePng(32, 32, drawVariant(32, variant)));
  console.log(`wrote assets/${name}.png and assets/${name}@2x.png`);
}

/**
 * The 256px application icon used by the installer and the exe: the same two bars on a dark rounded
 * tile, one mostly full (green) and one partly full (amber). electron-builder converts it to .ico.
 */
function drawAppIcon(size) {
  const rgba = Buffer.alloc(size * size * 4, 0);
  const bg = [0x14, 0x17, 0x1c];
  const track = [0x26, 0x2b, 0x33];
  const radius = size * 0.2;
  const bars = [
    { y0: 0.3, y1: 0.44, fill: 0.72, color: [0x3f, 0xb9, 0x50] },
    { y0: 0.56, y1: 0.7, fill: 0.46, color: [0xd2, 0x99, 0x22] },
  ];
  const left = size * 0.18;
  const right = size * 0.82;

  const insideRounded = (px, py, x0, y0, x1, y1, r) => {
    const cx = Math.min(Math.max(px, x0 + r), x1 - r);
    const cy = Math.min(Math.max(py, y0 + r), y1 - r);
    return (px - cx) ** 2 + (py - cy) ** 2 <= r * r;
  };

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const px = x + 0.5;
      const py = y + 0.5;
      if (!insideRounded(px, py, 0, 0, size, size, radius)) continue;
      let color = bg;
      for (const bar of bars) {
        const top = size * bar.y0;
        const bottom = size * bar.y1;
        const r = (bottom - top) / 2;
        if (!insideRounded(px, py, left, top, right, bottom, r)) continue;
        color = px <= left + (right - left) * bar.fill ? bar.color : track;
      }
      const offset = (y * size + x) * 4;
      rgba[offset] = color[0];
      rgba[offset + 1] = color[1];
      rgba[offset + 2] = color[2];
      rgba[offset + 3] = 255;
    }
  }
  return rgba;
}

writeFileSync(join(outDir, "icon.png"), encodePng(256, 256, drawAppIcon(256)));
console.log("wrote assets/icon.png");
