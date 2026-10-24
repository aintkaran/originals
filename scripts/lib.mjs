// Pure helpers (unit tested). No I/O.
export const WIDTHS = [600, 1200, 2400];
export const IMAGE_EXT_RE = /\.(jpe?g|png|webp|avif|tiff?)$/i;
export const HEIC_EXT_RE = /\.(heic|heif)$/i;

export function lineCol(text, pos) {
  const before = text.slice(0, pos);
  const lines = before.split('\n');
  return { line: lines.length, column: lines[lines.length - 1].length + 1 };
}

export function parseMeta(text, label) {
  const warnings = [];
  if (text == null) return { meta: {}, warnings };
  try {
    const m = JSON.parse(text);
    if (!m || typeof m !== 'object' || Array.isArray(m)) throw new Error('top level must be an object');
    return { meta: m, warnings };
  } catch (e) {
    let pos = /position (\d+)/.exec(e.message)?.[1];
    if (pos == null) {
      // Older V8 messages carry only a snippet around the bad token; locate it.
      const m = /Unexpected token '(.)', "([\s\S]*)" is not valid JSON/.exec(e.message);
      if (m) {
        const core = m[2].replace(/^\.\.\./, '').replace(/\.\.\.$/, '');
        const at = text.indexOf(core);
        if (at >= 0) pos = at + Math.max(0, core.indexOf(m[1]));
      }
    }
    const where = pos != null ? ` (line ${lineCol(text, +pos).line}, column ${lineCol(text, +pos).column})` : '';
    warnings.push(`${label}: meta.json is malformed${where}: ${e.message}. Using defaults.`);
    return { meta: {}, warnings };
  }
}

// meta.images may be an array of {file,...} (current format) or an object keyed by stem.
export function metaImageMap(meta) {
  const out = new Map();
  if (Array.isArray(meta.images)) {
    for (const i of meta.images) if (i && i.file != null) out.set(String(i.file), i);
  } else if (meta.images && typeof meta.images === 'object') {
    for (const [k, v] of Object.entries(meta.images)) out.set(k, { ...v, file: k });
  }
  return out;
}

export function validateNames(project, files) {
  const errors = [], warnings = [];
  const seen = new Map();
  if (/[A-Z ]/.test(project)) warnings.push(`${project}: folder name has spaces/uppercase; kept as the slug.`);
  for (const f of files) {
    if (HEIC_EXT_RE.test(f)) { errors.push(`${project}/${f}: HEIC/HEIF is not supported. Convert to JPEG or TIFF.`); continue; }
    if (!IMAGE_EXT_RE.test(f)) continue;
    const stem = f.replace(IMAGE_EXT_RE, '');
    if (/-(600|1200|2400)$/.test(stem)) errors.push(`${project}/${f}: name ends in -600/-1200/-2400, which is reserved for exports. Rename it.`);
    if (/[#?%]/.test(stem) || /[^\x00-\x7F]/.test(stem)) errors.push(`${project}/${f}: name has #, ?, % or non-ASCII characters. Rename it.`);
    else if (/\s/.test(stem)) warnings.push(`${project}/${f}: name contains spaces (works, but avoid).`);
    const key = stem.toLowerCase();
    if (seen.has(key)) errors.push(`${project}: "${seen.get(key)}" and "${f}" collide (same name ignoring case/extension).`);
    else seen.set(key, f);
  }
  return { errors, warnings };
}

const cleanMaker = (make, model) => {
  if (!model) return make || '';
  if (!make) return model;
  const mk = make.trim().split(/\s+/)[0].toLowerCase();
  return model.toLowerCase().startsWith(mk) ? model : `${make.trim()} ${model}`;
};
const titleMake = s => s && s === s.toUpperCase() ? s.charAt(0) + s.slice(1).toLowerCase() : s;

export function formatShutter(t) {
  if (!(t > 0)) return '';
  if (t >= 1) return `${+t.toFixed(1)}s`;
  return `1/${Math.round(1 / t)}s`;
}

export function captionParts(exif, cfg = {}) {
  if (!exif) return {};
  const make = titleMake((exif.Make || '').trim());
  const model = (exif.Model || '').trim();
  let camera = cleanMaker(make, model);
  if (camera && make && model && model.toLowerCase().startsWith(make.toLowerCase())) camera = model;
  const focal = exif.FocalLengthIn35mmFormat || exif.FocalLength;
  return {
    camera: cfg.showCamera === false ? '' : camera,
    lens: cfg.showLens === false ? '' : (exif.LensModel || '').trim(),
    focal: focal ? `${Math.round(focal)}mm` : '',
    aperture: exif.FNumber ? String(+Number(exif.FNumber).toFixed(1)) : '',
    shutter: formatShutter(Number(exif.ExposureTime)),
    iso: exif.ISO ? String(exif.ISO) : ''
  };
}

// Template segments are separated by cfg.separator; a segment with any empty field is dropped.
export function formatCaption(exif, cfg) {
  const parts = captionParts(exif, cfg);
  const sep = cfg.separator ?? ' / ';
  const out = [];
  for (const seg of cfg.captionTemplate.split(sep)) {
    let ok = true;
    const s = seg.replace(/\{(\w+)\}/g, (_, k) => { if (!parts[k]) ok = false; return parts[k] ?? ''; });
    if (ok && s.trim()) out.push(s.trim());
  }
  return out.join(sep);
}

export function toNum(v) {
  if (typeof v === 'number') return v;
  const s = String(v).trim();
  const f = /^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/.exec(s);
  if (f) return +f[2] ? +f[1] / +f[2] : NaN;
  return parseFloat(s);
}
export const EXIF_WHITELIST = ['Make', 'Model', 'LensModel', 'FocalLength', 'FocalLengthIn35mmFormat', 'FNumber', 'ExposureTime', 'ISO', 'DateTimeOriginal'];
export function pickExif(tags) {
  const o = {};
  for (const k of EXIF_WHITELIST) {
    let v = tags?.[k];
    if (v == null || v === '') continue;
    if (k === 'DateTimeOriginal') v = typeof v === 'string' ? v : (v.rawValue ?? v.toString?.() ?? '');
    if (typeof v === 'string' && !v.trim()) continue;
    if (['FocalLength', 'FocalLengthIn35mmFormat', 'FNumber', 'ExposureTime', 'ISO'].includes(k)) {
      v = toNum(v);
      if (!(v > 0)) continue;
    }
    o[k] = typeof v === 'string' ? v.trim() : v;
  }
  return o;
}

// Caption precedence: meta caption (even ""), auto from EXIF, empty.
export function resolveCaption(o, exif, cfg, exifAllowed = true) {
  if (o.caption !== undefined) return o.caption;
  if (!exifAllowed || o.exif === false) return '';
  return formatCaption(exif, cfg);
}

// alt: meta alt (even "" = decorative) wins; AI alt only when absent.
export function resolveAlt(o, aiAlt) {
  if (o.alt !== undefined) return { alt: o.alt, altSource: undefined };
  if (aiAlt) return { alt: aiAlt, altSource: 'ai' };
  return { alt: '', altSource: undefined };
}

export function deletionGuard({ existing, toDelete, imageCount, force }) {
  if (force) return null;
  if (imageCount === 0) return 'originals has zero images; refusing to wipe the site (use force to override).';
  if (existing > 0 && toDelete / existing > 0.25) return `run would delete ${toDelete} of ${existing} exports (>25%); aborting (use force to override).`;
  return null;
}

export function cleanAlt(s, max = 125) {
  let t = String(s || '').replace(/\s+/g, ' ').trim().replace(/^["']|["']$/g, '').replace(/^(an? )?(image|photo|picture|photograph) of /i, '');
  if (t) t = t[0].toUpperCase() + t.slice(1);
  if (t.length > max) t = t.slice(0, max - 1).replace(/\s+\S*$/, '') + '.';
  return t;
}
