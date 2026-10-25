// Reads camera, lens and exposure details from an image's EXIF block. No dependencies.
// Allow-list only: GPS, serial numbers, owner/artist/copyright, software and dates are never read.
const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

function readIfd(b, le, off, wanted) {
  const out = {};
  const u16 = o => le ? b.readUInt16LE(o) : b.readUInt16BE(o);
  const u32 = o => le ? b.readUInt32LE(o) : b.readUInt32BE(o);
  const i32 = o => le ? b.readInt32LE(o) : b.readInt32BE(o);
  if (off + 2 > b.length) return out;
  const n = Math.min(u16(off), 200);
  for (let i = 0; i < n; i++) {
    const e = off + 2 + i * 12;
    if (e + 12 > b.length) break;
    const tag = u16(e);
    if (!wanted.has(tag)) continue;
    const type = u16(e + 2), count = u32(e + 4), size = (TYPE_SIZE[type] || 0) * count;
    if (!size || count > 1000) continue;
    const at = size <= 4 ? e + 8 : u32(e + 8);
    if (at + size > b.length) continue;
    if (type === 2) out[tag] = b.toString('latin1', at, at + count).replace(/\0.*$/s, '').trim();
    else if (type === 3) out[tag] = u16(at);
    else if (type === 4) out[tag] = u32(at);
    else if (type === 5) { const d = u32(at + 4); out[tag] = d ? u32(at) / d : null; }
    else if (type === 10) { const d = i32(at + 4); out[tag] = d ? i32(at) / d : null; }
  }
  return out;
}

const IFD0 = new Set([0x010f, 0x0110, 0x0112, 0x8769]);
const EXIF = new Set([0x829a, 0x829d, 0x8827, 0x9204, 0x920a, 0xa002, 0xa003, 0xa405, 0xa433, 0xa434]);
const clean = s => (typeof s === 'string' ? s.replace(/[^\x20-\x7E]/g, '').trim() : '');

export function parseExif(input) {
  try {
    let b = Buffer.from(input);
    if (b.toString('latin1', 0, 6) === 'Exif\0\0') b = b.subarray(6);
    const bo = b.toString('latin1', 0, 2);
    if (bo !== 'II' && bo !== 'MM') return null;
    const le = bo === 'II';
    if ((le ? b.readUInt16LE(2) : b.readUInt16BE(2)) !== 42) return null;
    const ifd0 = readIfd(b, le, le ? b.readUInt32LE(4) : b.readUInt32BE(4), IFD0);
    const ex = ifd0[0x8769] ? readIfd(b, le, ifd0[0x8769], EXIF) : {};
    return {
      make: clean(ifd0[0x010f]), model: clean(ifd0[0x0110]),
      lensMake: clean(ex[0xa433]), lensModel: clean(ex[0xa434]),
      exposureTime: ex[0x829a], fNumber: ex[0x829d], iso: ex[0x8827],
      focalLength: ex[0x920a], focalLength35: ex[0xa405], exposureBias: ex[0x9204],
      orientation: ifd0[0x0112] || 1, pixelWidth: ex[0xa002], pixelHeight: ex[0xa003]
    };
  } catch { return null; }
}

const num = (n, d = 1) => String(+n.toFixed(d));

export function formatExif(x) {
  if (!x) return '';
  const parts = [];
  const cam = x.model && x.make && !x.model.toLowerCase().startsWith(x.make.toLowerCase().split(' ')[0]) ? `${x.make} ${x.model}` : (x.model || x.make);
  if (cam) parts.push(`Camera: ${cam}`);
  if (x.lensModel) parts.push(`Lens: ${x.lensModel}`);
  if (x.focalLength > 0) parts.push(`Focal length: ${num(x.focalLength)} mm${x.focalLength35 > 0 ? ` (${x.focalLength35} mm equiv.)` : ''}`);
  if (x.fNumber > 0) parts.push(`Aperture: f/${num(x.fNumber)}`);
  if (x.exposureTime > 0) parts.push(`Shutter: ${x.exposureTime >= 1 ? `${num(x.exposureTime)} s` : `1/${Math.round(1 / x.exposureTime)} s`}`);
  if (x.iso > 0) parts.push(`ISO: ${x.iso}`);
  if (typeof x.exposureBias === 'number' && x.exposureBias !== 0) parts.push(`Exposure bias: ${x.exposureBias > 0 ? '+' : ''}${num(x.exposureBias, 2)} EV`);
  return parts.join(', ');
}

export const exifText = buf => formatExif(parseExif(buf));

// ---- HEIC/HEIF: pull the EXIF block and pixel size out of the ISOBMFF box
// structure so iPhone photos keep their camera data without conversion.
// Reads only what the allow-list above reads; GPS/serial/etc. stay untouched.

const CONTAINERS = new Set(['meta', 'iinf', 'iprp', 'ipco']);
const FULL_BOX = new Set(['meta', 'iinf', 'iloc', 'ispe', 'infe']); // 4 bytes of version/flags before the payload

// Walks the box tree, calling cb(type, payloadStart, payloadLen, depth).
function walkBoxes(b, start, end, depth, cb) {
  let o = start;
  while (o + 8 <= end) {
    let size = b.readUInt32BE(o);
    const type = b.toString('latin1', o + 4, o + 8);
    let head = 8;
    if (size === 1) { if (o + 16 > end) return; size = Number(b.readBigUInt64BE(o + 8)); head = 16; }
    else if (size === 0) size = end - o;
    if (size < head || o + size > end) return;
    let p = o + head;
    if (FULL_BOX.has(type)) p += 4;
    cb(type, o, p, o + size, depth);
    if (CONTAINERS.has(type)) {
      // iinf carries a 2-byte (v0) or 4-byte (v3) entry count before its infe children.
      const childStart = type === 'iinf' ? p + (b[o + 8] === 0 ? 2 : 4) : p;
      walkBoxes(b, childStart, o + size, depth + 1, cb);
    }
    o += size;
  }
}

// Finds the first 'Exif' item via iinf (item type) + iloc (extent offset/length).
// construction_method 0 (file offset) only, which is how camera HEIC is written.
export function extractHeicExif(buf) {
  const b = Buffer.from(buf);
  const exifIds = new Map(); // item_ID -> true for infe entries typed 'Exif'
  const locs = new Map();    // item_ID -> {offset, length}
  walkBoxes(b, 0, b.length, 0, (type, boxStart, payload, boxEnd) => {
    if (type === 'infe') {
      const ver = b[boxStart + 8];
      // version 2/3 carry item_type; ID is 2 bytes (v2) or 4 bytes (v3)
      const id = ver === 2 ? b.readUInt16BE(payload) : b.readUInt32BE(payload);
      const tOff = ver === 2 ? payload + 4 : payload + 6;
      if (b.toString('latin1', tOff, tOff + 4) === 'Exif') exifIds.set(id, true);
    } else if (type === 'iloc') {
      const ver = b[boxStart + 8];
      const s = b[payload]; // offset_size<<4 | length_size
      const offSize = s >> 4, lenSize = s & 15, baseSize = b[payload + 1] >> 4;
      const cnt = ver < 2 ? b.readUInt16BE(payload + 2) : b.readUInt32BE(payload + 2);
      let o = payload + (ver < 2 ? 4 : 6);
      for (let i = 0; i < cnt; i++) {
        const id = ver < 2 ? b.readUInt16BE(o) : b.readUInt32BE(o);
        o += ver < 2 ? 2 : 4;
        if (ver === 1 || ver === 2) { const cm = b.readUInt16BE(o) & 15; o += 2; if (cm !== 0) return; }
        o += 2; // data_reference_index
        let base = 0; for (let k = 0; k < baseSize; k++) base = base * 256 + b[o + k]; o += baseSize;
        const nExt = b.readUInt16BE(o); o += 2;
        for (let j = 0; j < nExt; j++) {
          if ((ver === 1 || ver === 2) && (b[payload + 1] & 15) > 0) o += (b[payload + 1] & 15); // extent_index
          let off = 0; for (let k = 0; k < offSize; k++) off = off * 256 + b[o + k]; o += offSize;
          let len = 0; for (let k = 0; k < lenSize; k++) len = len * 256 + b[o + k]; o += lenSize;
          if (!locs.has(id)) locs.set(id, { offset: base + off, length: len });
        }
      }
    }
  });
  for (const id of exifIds.keys()) {
    const l = locs.get(id);
    if (!l || l.offset + l.length > b.length || l.length < 6) continue;
    // The Exif item starts with a 4-byte offset to the TIFF header (usually 0).
    const skip = 4 + b.readUInt32BE(l.offset);
    const tiff = b.subarray(l.offset + skip, l.offset + l.length);
    const bo = tiff.toString('latin1', 0, 2);
    if (bo === 'II' || bo === 'MM') return tiff;
  }
  return null;
}

// Pixel dimensions from the first ispe box (width, height as uint32).
export function heicDimensions(buf) {
  const b = Buffer.from(buf);
  let dims = null;
  walkBoxes(b, 0, b.length, 0, (type, boxStart, payload) => {
    if (type === 'ispe' && !dims && payload + 8 <= b.length) dims = { width: b.readUInt32BE(payload), height: b.readUInt32BE(payload + 4) };
  });
  return dims;
}
