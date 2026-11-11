// Switch homebrew (.nro) metadata: the title, author, version and icon live in the "ASET"
// section appended after the executable. Format: switchbrew.org/wiki/NRO and /wiki/NACP.
import fs from 'node:fs/promises';

const NACP_SIZE = 0x4000;
const MAX_ICON = 1024 * 1024;

const cstr = buf => buf.toString('utf8').replace(/\0.*$/s, '').trim();

/** Returns { title, author, version, icon (JPEG Buffer|null) } or null if it isn't an NRO. */
export async function nroInfo(file) {
  const fh = await fs.open(file, 'r');
  try {
    const head = Buffer.alloc(0x20);
    await fh.read(head, 0, head.length, 0);
    if (head.toString('latin1', 0x10, 0x14) !== 'NRO0') return null;
    const base = head.readUInt32LE(0x18);           // assets start right after the NRO image
    const aset = Buffer.alloc(0x38);
    const { bytesRead } = await fh.read(aset, 0, aset.length, base);
    if (bytesRead < aset.length || aset.toString('latin1', 0, 4) !== 'ASET') return { title: null, author: null, version: null, icon: null };
    const section = i => ({ off: base + Number(aset.readBigUInt64LE(8 + i * 16)), len: Number(aset.readBigUInt64LE(16 + i * 16)) });
    const iconSec = section(0), nacpSec = section(1);

    let title = null, author = null, version = null;
    if (nacpSec.len >= NACP_SIZE) {
      const nacp = Buffer.alloc(NACP_SIZE);
      await fh.read(nacp, 0, NACP_SIZE, nacpSec.off);
      for (let lang = 0; lang < 16 && !title; lang++) {   // first language with a name (0 = American English)
        const o = lang * 0x300;
        title = cstr(nacp.subarray(o, o + 0x200)) || null;
        author = cstr(nacp.subarray(o + 0x200, o + 0x300)) || null;
      }
      version = cstr(nacp.subarray(0x3060, 0x3070)) || null;
    }

    let icon = null;
    if (iconSec.len > 0 && iconSec.len <= MAX_ICON) {
      icon = Buffer.alloc(iconSec.len);
      await fh.read(icon, 0, iconSec.len, iconSec.off);
      if (icon[0] !== 0xff || icon[1] !== 0xd8) icon = null;     // expect a JPEG
    }
    return { title, author, version, icon };
  } finally {
    await fh.close();
  }
}
