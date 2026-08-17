/* Put several files into one, which is what a `.zip` is.
 *
 * A glTF written the readable way is two files — the JSON and the buffer it
 * names — and a browser can only hand over one at a time. Two downloads means
 * the browser stopping to ask whether you meant it, and then two files that
 * have to stay together and are easy to part. One archive is one download and
 * arrives as what it is: a pair.
 *
 * A zip is a plain enough thing to write. Each member gets a local header and
 * its bytes; then a central directory repeating those headers with the offset
 * each one started at; then a record saying where the directory is and how
 * many entries it holds. A reader finds the end record, walks the directory
 * backwards from it, and never has to guess.
 *
 * Deflate is the only compression here and `CompressionStream('deflate-raw')`
 * is exactly it — a zip stores the deflate stream without the zlib wrapper
 * that a PNG keeps. A member that does not get smaller is stored as it is
 * rather than written larger than it was.
 *
 * What is not written: ZIP64, so nothing over four gigabytes; encryption; and
 * directory entries, since a flat archive of two files needs none.
 */
'use strict';

const FbxZip = (function () {
  const LOCAL = 0x04034b50;
  const CENTRAL = 0x02014b50;
  const END = 0x06054b50;
  //: Deflate, and the version of the format that first had it.
  const DEFLATED = 8;
  const STORED = 0;
  const VERSION = 20;
  //: Names are UTF-8, which the format says by this bit rather than by hoping.
  const UTF8 = 0x0800;
  //: A zip counts sizes and offsets in 32 bits, and ZIP64 is not written here.
  const LIMIT = 0xffffffff;

  const TEXT = new TextEncoder();

  /** Everything a compression stream hands back, joined. */
  async function drain(stream) {
    const reader = stream.getReader();
    const parts = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      total += value.length;
    }
    const out = new Uint8Array(total);
    let at = 0;
    for (const part of parts) { out.set(part, at); at += part.length; }
    return out;
  }

  /**
   * A date and time as MS-DOS wrote them, which is what a zip entry carries.
   *
   * Two seconds is the resolution, and 1980 is the year zero. A date before
   * that cannot be written, so it is held at the floor rather than wrapping
   * round to something in the future.
   */
  function dosTime(when) {
    const year = Math.max(when.getFullYear(), 1980);
    return {
      date: ((year - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate(),
      time: (when.getHours() << 11) | (when.getMinutes() << 5)
        | (when.getSeconds() >> 1),
    };
  }

  /**
   * *files* — `[{ name, bytes }]` — as one archive.
   *
   * *modified* is the timestamp every member is stamped with, and defaults to
   * now. Returns null where the platform has no deflate to offer, which leaves
   * the caller to hand over the files separately rather than write an archive
   * nothing can open.
   */
  async function write(files, modified) {
    if (typeof CompressionStream !== 'function') return null;
    if (!Array.isArray(files) || !files.length) return null;
    const stamp = dosTime(modified || new Date());

    const members = [];
    for (const file of files) {
      const name = TEXT.encode(String(file.name));
      const bytes = file.bytes instanceof Uint8Array
        ? file.bytes : new Uint8Array(file.bytes);
      if (bytes.length > LIMIT) return null;
      const packed = await drain(new Blob([bytes]).stream()
        .pipeThrough(new CompressionStream('deflate-raw')));
      const smaller = packed.length < bytes.length;
      members.push({
        name,
        crc: FbxPng.crc32(bytes),
        method: smaller ? DEFLATED : STORED,
        payload: smaller ? packed : bytes,
        size: bytes.length,
      });
    }

    const header = (signature, member, offset) => {
      const central = signature === CENTRAL;
      const out = new Uint8Array((central ? 46 : 30) + member.name.length);
      const view = new DataView(out.buffer);
      view.setUint32(0, signature, true);
      let at = 4;
      if (central) { view.setUint16(at, VERSION, true); at += 2; }
      view.setUint16(at, VERSION, true);
      view.setUint16(at + 2, UTF8, true);
      view.setUint16(at + 4, member.method, true);
      view.setUint16(at + 6, stamp.time, true);
      view.setUint16(at + 8, stamp.date, true);
      view.setUint32(at + 10, member.crc, true);
      view.setUint32(at + 14, member.payload.length, true);
      view.setUint32(at + 18, member.size, true);
      view.setUint16(at + 22, member.name.length, true);
      view.setUint16(at + 24, 0, true);                 // no extra field
      at += 26;
      if (central) {
        view.setUint16(at, 0, true);                    // no comment
        view.setUint16(at + 2, 0, true);                // the one disk there is
        view.setUint16(at + 4, 0, true);                // nothing internal
        view.setUint32(at + 6, 0, true);                // nor external
        view.setUint32(at + 10, offset, true);
        at += 14;
      }
      out.set(member.name, at);
      return out;
    };

    const parts = [];
    let offset = 0;
    for (const member of members) {
      member.offset = offset;
      const local = header(LOCAL, member, 0);
      parts.push(local, member.payload);
      offset += local.length + member.payload.length;
    }
    const directoryAt = offset;
    for (const member of members) {
      const entry = header(CENTRAL, member, member.offset);
      parts.push(entry);
      offset += entry.length;
    }
    if (offset > LIMIT) return null;

    const end = new Uint8Array(22);
    const view = new DataView(end.buffer);
    view.setUint32(0, END, true);
    view.setUint16(8, members.length, true);
    view.setUint16(10, members.length, true);
    view.setUint32(12, offset - directoryAt, true);
    view.setUint32(16, directoryAt, true);
    parts.push(end);

    const out = new Uint8Array(offset + end.length);
    let to = 0;
    for (const part of parts) { out.set(part, to); to += part.length; }
    return out;
  }

  return { write, dosTime };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = FbxZip;
