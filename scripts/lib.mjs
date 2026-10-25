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

export function deletionGuard({ existing, toDelete, imageCount, force }) {
  if (force) return null;
  if (imageCount === 0) return 'originals has zero images; refusing to wipe the site (use force to override).';
  if (existing > 0 && toDelete / existing > 0.25) return `run would delete ${toDelete} of ${existing} exports (>25%); aborting (use force to override).`;
  return null;
}
