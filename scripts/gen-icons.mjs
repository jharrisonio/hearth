import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const outDir = path.join(import.meta.dirname, "../apps/web/public/icons");
mkdirSync(outDir, { recursive: true });

for (const size of [192, 512]) {
  writeFileSync(path.join(outDir, `icon-${size}.png`), png(size));
}

function png(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const ink = [0, 0, 0, 255];
  const cream = [255, 255, 255, 255];
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < size; x++) {
      const pixel = isH(x / size, y / size) ? cream : ink;
      const offset = row + 1 + x * 4;
      raw[offset] = pixel[0];
      raw[offset + 1] = pixel[1];
      raw[offset + 2] = pixel[2];
      raw[offset + 3] = pixel[3];
    }
  }
  const idat = deflateSync(raw);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr(size)),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function isH(x, y) {
  const inBar = (x >= 0.28 && x <= 0.4) || (x >= 0.6 && x <= 0.72);
  const stem = y >= 0.22 && y <= 0.78 && inBar;
  const cross = y >= 0.46 && y <= 0.56 && x >= 0.28 && x <= 0.72;
  return stem || cross;
}

function ihdr(size) {
  const buffer = Buffer.alloc(13);
  buffer.writeUInt32BE(size, 0);
  buffer.writeUInt32BE(size, 4);
  buffer[8] = 8;
  buffer[9] = 6;
  return buffer;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0, 0);
  return Buffer.concat([length, body, crc]);
}

function crc32(buffer) {
  let crc = ~0;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return ~crc;
}
