import { qrcodegen } from "./vendor/qrcodegen.js";

/**
 * Encode a non-empty string as a QR Model 2 matrix with level Q correction.
 * No browser APIs, Node globals, network requests, or runtime npm packages.
 * The 512-character / version-20 limits prevent excessive work on bad input;
 * ordinary Telegram bot deep links fit comfortably within both limits.
 */
export function createQrMatrix(text) {
  if (typeof text !== "string" || text.length === 0) {
    throw new TypeError("QR text must be a non-empty string");
  }
  if (text.length > 512) {
    throw new RangeError("QR text must not exceed 512 UTF-16 code units");
  }
  const qr = qrcodegen.QrCode.encodeSegments(
    qrcodegen.QrSegment.makeSegments(text),
    qrcodegen.QrCode.Ecc.QUARTILE,
    1,
    20,
    -1,
    false,
  );
  const modules = Array.from({ length: qr.size }, (_, y) =>
    Array.from({ length: qr.size }, (_, x) => qr.getModule(x, y)),
  );
  return { size: qr.size, version: qr.version, errorCorrection: "Q", modules };
}

/**
 * Return a deterministic, opaque, lossless PNG as Uint8Array.
 * Defaults: 8 pixels per QR module, 4-module white quiet zone, level Q.
 * PNG uses 1-bit grayscale and a small DEFLATE encoder for repeated rows.
 *
 * @param {string} text
 * @param {{ scale?: number, quietZone?: number }} [options]
 * @returns {Uint8Array}
 */
export function createQrPng(text, options = {}) {
  const { scale = 8, quietZone = 4 } = options;
  if (!Number.isInteger(scale) || scale < 2 || scale > 16) {
    throw new RangeError("QR scale must be an integer from 2 to 16");
  }
  if (!Number.isInteger(quietZone) || quietZone < 4 || quietZone > 16) {
    throw new RangeError("QR quiet zone must be an integer from 4 to 16");
  }
  const qr = createQrMatrix(text);
  const side = (qr.size + 2 * quietZone) * scale;
  const rowBytes = Math.ceil(side / 8);
  const stride = rowBytes + 1;
  const scanlines = new Uint8Array(side * stride);
  scanlines.fill(0xff);
  for (let y = 0; y < side; y++) scanlines[y * stride] = 0;

  for (let y = 0; y < qr.size; y++) {
    const row = new Uint8Array(rowBytes);
    row.fill(0xff);
    for (let x = 0; x < qr.size; x++) {
      if (!qr.modules[y][x]) continue;
      const pixelX = (x + quietZone) * scale;
      for (let dx = 0; dx < scale; dx++) {
        const position = pixelX + dx;
        row[position >>> 3] &= ~(0x80 >>> (position & 7));
      }
    }
    for (let dy = 0; dy < scale; dy++) {
      scanlines.set(row, ((y + quietZone) * scale + dy) * stride + 1);
    }
  }

  const header = new Uint8Array(13);
  writeUint32(header, 0, side);
  writeUint32(header, 4, side);
  header[8] = 1; // One bit per pixel.
  header[9] = 0; // Grayscale: zero is black, one is white.
  return concatenate([
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateRows(scanlines, stride)),
    pngChunk("IEND", new Uint8Array(0)),
  ]);
}

function concatenate(parts) {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function writeUint32(target, offset, value) {
  target[offset] = value >>> 24;
  target[offset + 1] = value >>> 16;
  target[offset + 2] = value >>> 8;
  target[offset + 3] = value;
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let remainder = value;
  for (let bit = 0; bit < 8; bit++) {
    remainder = (remainder >>> 1) ^ ((remainder & 1) ? 0xedb88320 : 0);
  }
  return remainder >>> 0;
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const chunk = new Uint8Array(data.length + 12);
  writeUint32(chunk, 0, data.length);
  for (let index = 0; index < 4; index++) chunk[4 + index] = type.charCodeAt(index);
  chunk.set(data, 8);
  writeUint32(chunk, chunk.length - 4, crc32(chunk.subarray(4, chunk.length - 4)));
  return chunk;
}

function reverseBits(value, length) {
  let reversed = 0;
  for (let bit = 0; bit < length; bit++) {
    reversed = (reversed << 1) | (value & 1);
    value >>>= 1;
  }
  return reversed;
}

const FIXED_CODES = Array.from({ length: 288 }, (_, symbol) => {
  if (symbol <= 143) return [reverseBits(0x30 + symbol, 8), 8];
  if (symbol <= 255) return [reverseBits(0x190 + symbol - 144, 9), 9];
  if (symbol <= 279) return [reverseBits(symbol - 256, 7), 7];
  return [reverseBits(0xc0 + symbol - 280, 8), 8];
});

const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DISTANCE_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DISTANCE_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

/**
 * RFC 1950/1951 zlib stream with one final fixed-Huffman DEFLATE block.
 * QR pixel rows repeat at least `scale` times. Reusing the previous complete
 * row gives compact files without a general-purpose compressor dependency.
 */
function deflateRows(data, stride) {
  const bytes = [0x78, 0x01];
  let pending = 0;
  let pendingBits = 0;
  function writeBits(value, length) {
    pending |= value << pendingBits;
    pendingBits += length;
    while (pendingBits >= 8) {
      bytes.push(pending & 0xff);
      pending >>>= 8;
      pendingBits -= 8;
    }
  }
  function writeSymbol(symbol) {
    const [code, length] = FIXED_CODES[symbol];
    writeBits(code, length);
  }
  function writeMatch(length, distance) {
    let lengthCode = LENGTH_BASE.length - 1;
    while (LENGTH_BASE[lengthCode] > length) lengthCode--;
    writeSymbol(257 + lengthCode);
    writeBits(length - LENGTH_BASE[lengthCode], LENGTH_EXTRA[lengthCode]);
    let distanceCode = DISTANCE_BASE.length - 1;
    while (DISTANCE_BASE[distanceCode] > distance) distanceCode--;
    writeBits(reverseBits(distanceCode, 5), 5);
    writeBits(distance - DISTANCE_BASE[distanceCode], DISTANCE_EXTRA[distanceCode]);
  }
  function matchesPreviousRow(position) {
    for (let offset = 0; offset < stride; offset++) {
      if (data[position + offset] !== data[position - stride + offset]) return false;
    }
    return true;
  }

  writeBits(1, 1); // BFINAL.
  writeBits(1, 2); // BTYPE: fixed Huffman codes.
  let position = 0;
  while (position < data.length) {
    if (position >= stride && matchesPreviousRow(position)) {
      let end = position + stride;
      while (end < data.length && matchesPreviousRow(end)) end += stride;
      while (end - position >= 3) {
        const length = Math.min(258, end - position);
        writeMatch(length, stride);
        position += length;
      }
      while (position < end) writeSymbol(data[position++]);
    } else {
      const end = position + stride;
      while (position < end) writeSymbol(data[position++]);
    }
  }
  writeSymbol(256); // End of block.
  if (pendingBits > 0) bytes.push(pending & 0xff);

  let a = 1;
  let b = 0;
  for (const byte of data) {
    a += byte;
    if (a >= 65521) a -= 65521;
    b += a;
    if (b >= 65521) b -= 65521;
  }
  bytes.push((b >>> 8) & 0xff, b & 0xff, (a >>> 8) & 0xff, a & 0xff);
  return Uint8Array.from(bytes);
}
