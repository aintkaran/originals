import test from 'node:test';
import assert from 'node:assert/strict';
import { parseExif, formatExif, exifText } from '../scripts/exif.mjs';

// Builds a little-endian TIFF/EXIF block: IFD0 (make, model, exif ptr, GPS ptr) + Exif IFD.
function build() {
  const parts = [], ent = [];
  const str = s => Buffer.from(s + '\0', 'latin1');
  const makeS = str('Canon'), modelS = str('Canon EOS R5'), lensS = str('RF50mm F1.2 L USM'), serS = str('SN123456');
  const ifd0Count = 4, ex = [0x829a, 0x829d, 0x8827, 0x920a, 0xa434, 0xa431];
  const ifd0Off = 8, ifd0Len = 2 + ifd0Count * 12 + 4;
  const exOff = ifd0Off + ifd0Len, exLen = 2 + ex.length * 12 + 4;
  let data = exOff + exLen; const blobs = [];
  const put = buf => { const o = data; blobs.push(buf); data += buf.length; return o; };
  const e = (tag, type, count, val) => { const b = Buffer.alloc(12); b.writeUInt16LE(tag, 0); b.writeUInt16LE(type, 2); b.writeUInt32LE(count, 4); b.writeUInt32LE(val, 8); return b; };
  const rat = (n, d) => { const b = Buffer.alloc(8); b.writeUInt32LE(n, 0); b.writeUInt32LE(d, 4); return b; };
  const i0 = [e(0x010f, 2, makeS.length, put(makeS)), e(0x0110, 2, modelS.length, put(modelS)), e(0x8769, 4, 1, exOff), e(0x8825, 4, 1, 9999)];
  const x = [e(0x829a, 5, 1, put(rat(1, 200))), e(0x829d, 5, 1, put(rat(28, 10))), e(0x8827, 3, 1, 100),
    e(0x920a, 5, 1, put(rat(50, 1))), e(0xa434, 2, lensS.length, put(lensS)), e(0xa431, 2, serS.length, put(serS))];
  const hdr = Buffer.from([0x49, 0x49, 42, 0, 8, 0, 0, 0]);
  const cnt = n => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
  return Buffer.concat([hdr, cnt(i0.length), ...i0, Buffer.alloc(4), cnt(x.length), ...x, Buffer.alloc(4), ...blobs]);
}

test('reads camera, lens and exposure only', () => {
  const t = exifText(Buffer.concat([Buffer.from('Exif\0\0'), build()]));
  assert.equal(t, 'Camera: Canon EOS R5, Lens: RF50mm F1.2 L USM, Focal length: 50 mm, Aperture: f/2.8, Shutter: 1/200 s, ISO: 100');
  assert.ok(!/SN123456/.test(t));
});
test('garbage and empty input give no text', () => {
  assert.equal(exifText(Buffer.from('not exif')), '');
  assert.equal(parseExif(Buffer.alloc(0)), null);
  assert.equal(formatExif(null), '');
});
