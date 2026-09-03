/**
 * A minimal, dependency-free, DETERMINISTIC zip writer (W2.1/W2.2).
 *
 * Why not a library: the repo carries no archiver dependency, and the two
 * artifacts this produces — a Claude skill zip and a Cowork `.plugin` bundle —
 * are a handful of small text files. Store-only (method 0) is a page of code,
 * ships nothing new into the function bundle, and keeps the output byte-stable.
 *
 * DETERMINISM IS THE POINT. Every entry gets a fixed DOS timestamp, so the same
 * manifest renders the same bytes every time. That is what lets a test assert a
 * digest, and what lets an operator see that a re-export genuinely changed
 * something rather than just carrying a new mtime.
 */

/**
 * `content` takes a Buffer as well as a string because one entry this writer
 * produces is itself a zip: ChatGPT's Agent Studio installs a skill from a
 * `.zip` whose ROOT is `SKILL.md`, so the OpenAI bundle ships that inner
 * archive alongside the loose file. Store-only is exactly right for it — a zip
 * inside a zip should not be compressed twice.
 */
export type ZipEntry = { path: string; content: string | Buffer };

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

const crc32 = (buffer: Buffer): number => {
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[i]) & 0xff];
  return (crc ^ -1) >>> 0;
};

/** 1980-01-01T00:00:00 — the zero of the DOS date format, and stable forever. */
const DOS_TIME = 0;
const DOS_DATE = 0x0021;

export const createZip = (entries: readonly ZipEntry[]): Buffer => {
  // Sorted so entry ORDER cannot vary with object-key iteration.
  const sorted = [...entries].sort((a, b) => a.path.localeCompare(b.path));
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of sorted) {
    const nameBuffer = Buffer.from(entry.path, 'utf8');
    const dataBuffer = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content, 'utf8');
    const crc = crc32(dataBuffer);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4); // version needed
    localHeader.writeUInt16LE(0x0800, 6); // UTF-8 filename flag
    localHeader.writeUInt16LE(0, 8); // method: store
    localHeader.writeUInt16LE(DOS_TIME, 10);
    localHeader.writeUInt16LE(DOS_DATE, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(dataBuffer.length, 18);
    localHeader.writeUInt32LE(dataBuffer.length, 22);
    localHeader.writeUInt16LE(nameBuffer.length, 26);
    localHeader.writeUInt16LE(0, 28);
    locals.push(localHeader, nameBuffer, dataBuffer);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4); // version made by
    centralHeader.writeUInt16LE(20, 6); // version needed
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(DOS_TIME, 12);
    centralHeader.writeUInt16LE(DOS_DATE, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(dataBuffer.length, 20);
    centralHeader.writeUInt32LE(dataBuffer.length, 24);
    centralHeader.writeUInt16LE(nameBuffer.length, 28);
    centralHeader.writeUInt16LE(0, 30); // extra
    centralHeader.writeUInt16LE(0, 32); // comment
    centralHeader.writeUInt16LE(0, 34); // disk
    centralHeader.writeUInt16LE(0, 36); // internal attrs
    // `<< 16` overflows into a negative int32 in JS; `>>> 0` brings it back to
    // the unsigned value writeUInt32LE requires.
    centralHeader.writeUInt32LE(((0o100644 << 16) >>> 0) as number, 38); // external attrs: regular file, 0644
    centralHeader.writeUInt32LE(offset, 42);
    centrals.push(centralHeader, nameBuffer);

    offset += localHeader.length + nameBuffer.length + dataBuffer.length;
  }

  const centralBuffer = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(sorted.length, 8);
  end.writeUInt16LE(sorted.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuffer, end]);
};
