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

const IFD0 = new Set([0x010f, 0x0110, 0x8769]);
const EXIF = new Set([0x829a, 0x829d, 0x8827, 0x9204, 0x920a, 0xa405, 0xa433, 0xa434]);
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
      focalLength: ex[0x920a], focalLength35: ex[0xa405], exposureBias: ex[0x9204]
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
