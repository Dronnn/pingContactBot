import test from "node:test";
import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { Script } from "node:vm";
import { createQrMatrix, createQrPng } from "../tgcloud/lib/qr.js";

const TOKEN = "0123456789abcdef".repeat(3);
const DEEP_LINK = `https://t.me/${"a".repeat(29)}bot?start=c_${TOKEN}`;

function readPng(bytes) {
  const png = Buffer.from(bytes);
  assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const chunks = [];
  let width;
  let height;
  let offset = 8;
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    const payload = png.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = payload.readUInt32BE(0);
      height = payload.readUInt32BE(4);
      assert.equal(payload[8], 1, "one-bit image");
      assert.equal(payload[9], 0, "grayscale image");
    }
    if (type === "IDAT") chunks.push(payload);
    offset += length + 12;
  }
  assert.equal(offset, png.length, "no truncated or trailing PNG data");
  const pixels = inflateSync(Buffer.concat(chunks));
  const stride = Math.ceil(width / 8) + 1;
  assert.equal(pixels.length, stride * height);
  return {
    width,
    height,
    isWhite(x, y) {
      assert.equal(pixels[y * stride], 0, "unfiltered scanline");
      return Boolean(pixels[y * stride + 1 + (x >>> 3)] & (0x80 >>> (x & 7)));
    },
  };
}

test("longest supported bot-name deep link produces deterministic compact PNG", () => {
  const png = createQrPng(DEEP_LINK);
  assert.ok(png instanceof Uint8Array);
  assert.deepEqual(png, createQrPng(DEEP_LINK));
  assert.ok(png.length < 6000, `PNG unexpectedly large: ${png.length} bytes`);
  const qr = createQrMatrix(DEEP_LINK);
  const image = readPng(png);
  assert.equal(qr.errorCorrection, "Q");
  assert.equal(image.width, (qr.size + 8) * 8);
  assert.equal(image.height, image.width);
  const quietPixels = 32;
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      if (x < quietPixels || y < quietPixels || x >= image.width - quietPixels || y >= image.height - quietPixels) {
        assert.equal(image.isWhite(x, y), true, "quiet zone must stay white");
      }
    }
  }
});

test("non-byte-aligned scale produces whole square modules", () => {
  const qr = createQrMatrix(DEEP_LINK);
  const scale = 3;
  const quietZone = 5;
  const image = readPng(createQrPng(DEEP_LINK, { scale, quietZone }));
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          assert.equal(image.isWhite((x + quietZone) * scale + dx, (y + quietZone) * scale + dy), !qr.modules[y][x]);
        }
      }
    }
  }
});

test("invalid input and unreadable rendering options are rejected", () => {
  for (const text of ["", null, undefined, 123]) assert.throws(() => createQrPng(text), TypeError);
  assert.throws(() => createQrPng("a".repeat(513)), RangeError);
  assert.throws(() => createQrPng(DEEP_LINK, { quietZone: 3 }), RangeError);
  assert.throws(() => createQrPng(DEEP_LINK, { scale: 1 }), RangeError);
  assert.throws(() => createQrPng(DEEP_LINK, { scale: 3.5 }), RangeError);
});

test("offline print page accepts c_48hex and uses the same working QR engine", () => {
  const html = readFileSync(new URL("../tools/print-qr.html", import.meta.url), "utf8");
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  new Script(script); // Parse the complete page script without browser globals.
  const engine = script.split("/* QR_MODULE_END */")[0];
  const previewPng = new Script(`${engine}\ncreateQrPng(${JSON.stringify(DEEP_LINK)});`).runInNewContext();
  assert.deepEqual(Buffer.from(previewPng), Buffer.from(createQrPng(DEEP_LINK)));
  const start = script.indexOf("  function validateLink(value) {");
  const end = script.indexOf("  function makeCard(", start);
  assert.ok(start >= 0 && end > start, "print-page URL validator exists");
  const validateLink = new Script(`(${script.slice(start, end).trim()})`).runInNewContext({ URL });
  assert.equal(validateLink(DEEP_LINK), DEEP_LINK);
  assert.throws(() => validateLink(DEEP_LINK.slice(0, -1)), /полный код вещи/);
  assert.throws(() => validateLink(DEEP_LINK.replace(TOKEN, TOKEN.slice(0, 32))), /полный код вещи/);
  assert.throws(() => validateLink(DEEP_LINK.replace("t.me", "example.com")), /Нужна ссылка/);
  assert.ok(!/<script\b[^>]*\bsrc\s*=|<link\b[^>]*\bhref\s*=/i.test(html), "page loads no external scripts or styles");
});

// Independent decoder check. Optional only because production has no Python
// dependency. Install tests/requirements-qr.txt into a separate directory,
// then set QR_TEST_DECODER_PATH to it. QR_TEST_PYTHON may select an interpreter.
test("independent ZXing decoder recovers complete payloads from generated PNGs", {
  skip: process.env.QR_TEST_DECODER_PATH ? false : "Optional QR decoding check: install tests/requirements-qr.txt and set QR_TEST_DECODER_PATH (see tests/QR_TESTING.md).",
}, () => {
  const samples = [
    { text: DEEP_LINK, options: {} },
    { text: `https://t.me/contact_thing_bot?start=c_${"f".repeat(48)}`, options: { scale: 3, quietZone: 4 } },
    { text: "Андрей · Երևան · Contact for my keys", options: { scale: 6, quietZone: 6 } },
    { text: "7", options: { scale: 2, quietZone: 4 } },
    { text: "X".repeat(512), options: { scale: 16, quietZone: 16 } },
  ];
  const input = samples.map(({ text, options }) => ({ text, png: Buffer.from(createQrPng(text, options)).toString("base64") }));
  const result = spawnSync(process.env.QR_TEST_PYTHON || "python3", ["-c", `
import sys, json, io, base64
from PIL import Image
import zxingcpp
for sample in json.load(sys.stdin):
    image = Image.open(io.BytesIO(base64.b64decode(sample["png"])))
    image.load()
    result = zxingcpp.read_barcode(image)
    assert result is not None, "No QR code found"
    assert result.text == sample["text"], (result.text, sample["text"])
print("Decoded all five samples, including Unicode, 32-character bot name with c_48hex, and rendering boundaries.")
`], {
    input: JSON.stringify(input),
    encoding: "utf8",
    timeout: 15000,
    env: { ...process.env, PYTHONPATH: [process.env.QR_TEST_DECODER_PATH, process.env.PYTHONPATH].filter(Boolean).join(":") },
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
