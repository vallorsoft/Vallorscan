// PWA ikonok generálása külső függőség nélkül (sötét háttér + világoskék "V").
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '..', 'public', 'icons');
fs.mkdirSync(OUT, { recursive: true });

const BG = [15, 23, 42];      // #0f172a
const FG = [56, 189, 248];    // #38bdf8

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type, data) {
  const t = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([t, data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function makePng(size) {
  const px = Buffer.alloc(size * size * 4);
  const set = (x, y, c) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; px[i + 3] = 255;
  };
  // háttér
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) set(x, y, BG);
  // "V" alakzat két vastag vonalból
  const m = size * 0.26, top = size * 0.30, bot = size * 0.72, w = size * 0.085;
  const cx = size / 2;
  const drawThick = (x0, y0, x1, y1) => {
    const steps = size * 2;
    for (let s = 0; s <= steps; s++) {
      const x = x0 + (x1 - x0) * (s / steps);
      const y = y0 + (y1 - y0) * (s / steps);
      for (let dy = -w; dy <= w; dy++) for (let dx = -w; dx <= w; dx++)
        if (dx * dx + dy * dy <= w * w) set(Math.round(x + dx), Math.round(y + dy), FG);
    }
  };
  drawThick(m, top, cx, bot);
  drawThick(size - m, top, cx, bot);

  // PNG sorok filter bájttal
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8 bit, RGBA
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

for (const size of [192, 512]) {
  fs.writeFileSync(path.join(OUT, `icon-${size}.png`), makePng(size));
  console.log(`icon-${size}.png kész`);
}
