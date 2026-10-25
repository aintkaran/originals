// Shared test fixture: a minimal HEIC-shaped ISOBMFF file (not a *.test.mjs so it never runs alone).
// Layout: ftyp + meta(iinf[infe Exif], iloc, iprp/ipco/ispe) + mdat, matching how cameras write HEIC.
export function buildHeic(tiff) {
  const box = (type, ...parts) => {
    const body = Buffer.concat(parts);
    const b = Buffer.alloc(8 + body.length);
    b.writeUInt32BE(8 + body.length, 0); b.write(type, 4, 'latin1'); body.copy(b, 8);
    return b;
  };
  const exifPayload = Buffer.concat([Buffer.alloc(4), tiff]); // 4-byte offset-to-TIFF (0), then the TIFF header
  const infeBody = (() => { // version 2: version/flags, item_ID, protection_index, item_type
    const b = Buffer.alloc(12);
    b.writeUInt32BE(2 << 24, 0);
    b.writeUInt16BE(7, 4); b.writeUInt16BE(0, 6); b.write('Exif', 8, 'latin1');
    return b;
  })();
  const iinf = box('iinf', Buffer.from([0, 0, 0, 0, 0, 1]), box('infe', infeBody)); // version 0, 1 entry
  const ilocBody = (() => { // version 0, offset_size=4, length_size=4, base_offset_size=0
    const b = Buffer.alloc(22);
    b[4] = 0x44; // offset_size=4, length_size=4
    b.writeUInt16BE(1, 6);  // item_count
    b.writeUInt16BE(7, 8);  // item_ID
    b.writeUInt16BE(0, 10); // data_reference_index
    b.writeUInt16BE(1, 12); // extent_count
    return b; // extent offset/length patched below
  })();
  const ispeBody = (() => { const b = Buffer.alloc(12); b.writeUInt32BE(4032, 4); b.writeUInt32BE(3024, 8); return b; })();
  const iprp = box('iprp', box('ipco', box('ispe', ispeBody)));
  const ftyp = box('ftyp', Buffer.from('heic\0\0\0\0heic', 'latin1'));
  const metaLen = 8 + 4 + iinf.length + (8 + ilocBody.length) + iprp.length;
  const exifOff = ftyp.length + metaLen + 8; // ftyp + meta + mdat header
  ilocBody.writeUInt32BE(exifOff, 14); ilocBody.writeUInt32BE(exifPayload.length, 18);
  const iloc = box('iloc', ilocBody);
  const meta = box('meta', Buffer.alloc(4), iinf, iloc, iprp);
  const mdat = box('mdat', exifPayload);
  return Buffer.concat([ftyp, meta, mdat]);
}
