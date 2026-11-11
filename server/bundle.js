import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const run = promisify(execFile);

export const PACKAGE_RE = /\.(apk|apkm|apks|xapk)$/i;
export const isBundle = f => /\.(apkm|apks|xapk)$/i.test(f);

export async function isBundleFile(file) {
  try {
    const { stdout } = await run('unzip', ['-Z1', file], { maxBuffer: 16 * 1024 * 1024 });
    const names = stdout.split('\n').map(s => s.trim());
    if (names.includes('AndroidManifest.xml')) return false;
    if (names.some(n => /\.apk$/i.test(n))) return true;
  } catch { /* not a zip we can list: go by the name */ }
  return isBundle(file);
}

const ABI_SPLIT = { 'x86_64': 'x86_64', 'x86': 'x86', 'arm64-v8a': 'arm64_v8a', 'armeabi-v7a': 'armeabi_v7a', 'armeabi': 'armeabi' };
const ALL_ABI_TOKENS = Object.values(ABI_SPLIT);
const abiOf = name => ALL_ABI_TOKENS.find(t => new RegExp(`[._]${t}\\.apk$`, 'i').test(name));

async function walk(dir) {
  const out = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...await walk(p)); else out.push(p);
  }
  return out;
}

export async function extract(file) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rose-bundle-'));
  try {
    await run('unzip', ['-o', '-qq', file, '-d', dir], { maxBuffer: 16 * 1024 * 1024 });
  } catch (e) {
    if ((await fs.readdir(dir)).length === 0) {
      await fs.rm(dir, { recursive: true, force: true });
      throw new Error(`could not open bundle (corrupt or encrypted?): ${e.message.split('\n')[0]}`);
    }
  }
  const files = await walk(dir);
  const apks = files.filter(f => /\.apk$/i.test(f));
  if (!apks.length) {
    await fs.rm(dir, { recursive: true, force: true });
    throw new Error('bundle contains no .apk files');
  }
  const obbs = files.filter(f => /\.obb$/i.test(f));
  return { dir, apks, obbs, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

export function selectApks(apks, deviceAbis) {
  const generic = apks.filter(a => !abiOf(path.basename(a)));
  const abiSplits = apks.filter(a => abiOf(path.basename(a)));
  if (!abiSplits.length) return generic;
  for (const abi of deviceAbis) {
    const tok = ABI_SPLIT[abi];
    const hit = abiSplits.find(a => abiOf(path.basename(a)) === tok);
    if (hit) return [...generic, hit];
  }
  throw new Error(`bundle has no native code for this device (has: ${abiSplits.map(a => abiOf(path.basename(a))).join(', ')}; device: ${deviceAbis.join(', ')})`);
}

export async function metadata(file) {
  const b = await extract(file);
  try {
    let name = null, pkg = null;
    for (const metaFile of ['info.json', 'manifest.json']) {
      try {
        const j = JSON.parse(await fs.readFile(path.join(b.dir, metaFile), 'utf8'));
        name ??= j.app_name || j.name || null;
        pkg ??= j.pname || j.package_name || null;
      } catch { /* not present */ }
    }
    let icon = null;
    try { icon = await fs.readFile(path.join(b.dir, 'icon.png')); } catch { /* none */ }
    return { name, pkg, icon };
  } finally {
    await b.cleanup();
  }
}

export function manifestPackage(buf) {
  try {
    if (buf.readUInt16LE(0) !== 0x0003) return null;          // RES_XML_TYPE
    let off = buf.readUInt16LE(2), strings = null;
    while (off + 8 <= buf.length) {
      const type = buf.readUInt16LE(off), hsize = buf.readUInt16LE(off + 2), size = buf.readUInt32LE(off + 4);
      if (size < 8) return null;
      if (type === 0x0001) strings = stringPool(buf, off, hsize);
      else if (type === 0x0102 && strings) {                      // START_ELEMENT
        const ext = off + hsize;                                  // ns, name, attrStart, attrSize, attrCount...
        if (strings[buf.readUInt32LE(ext + 4)] !== 'manifest') return null;
        const attrStart = buf.readUInt16LE(ext + 8), attrSize = buf.readUInt16LE(ext + 10), count = buf.readUInt16LE(ext + 12);
        for (let i = 0; i < count; i++) {
          const a = ext + attrStart + i * attrSize;
          if (strings[buf.readUInt32LE(a + 4)] !== 'package') continue;
          const raw = buf.readUInt32LE(a + 8);
          const v = raw !== 0xffffffff ? strings[raw] : buf.readUInt8(a + 15) === 0x03 ? strings[buf.readUInt32LE(a + 16)] : null;
          return /^[A-Za-z][\w]*(\.[A-Za-z_][\w]*)+$/.test(v || '') ? v : null;
        }
        return null;
      }
      off += size;
    }
  } catch { /* truncated or not binary XML */ }
  return null;
}

function stringPool(buf, off, hsize) {
  const count = buf.readUInt32LE(off + 8), flags = buf.readUInt32LE(off + 16), start = buf.readUInt32LE(off + 20);
  const utf8 = !!(flags & 0x100), out = new Array(count);
  for (let i = 0; i < count; i++) {
    let p = off + start + buf.readUInt32LE(off + hsize + i * 4);
    if (utf8) {
      p += buf[p] & 0x80 ? 2 : 1;                                 
      let n = buf[p]; if (n & 0x80) { n = ((n & 0x7f) << 8) | buf[p + 1]; p += 2; } else p += 1;
      out[i] = buf.toString('utf8', p, p + n);
    } else {
      let n = buf.readUInt16LE(p); if (n & 0x8000) { n = ((n & 0x7fff) << 16) | buf.readUInt16LE(p + 2); p += 4; } else p += 2;
      out[i] = buf.toString('utf16le', p, p + n * 2);
    }
  }
  return out;
}

const unzipEntry = (zip, entry) => run('unzip', ['-p', zip, entry], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 }).then(r => r.stdout);

/** Package name of an .apk or a split bundle, read from the file itself; null if it can't be told. */
export async function packageOf(file) {
  try {
    if (!(await isBundleFile(file))) return manifestPackage(await unzipEntry(file, 'AndroidManifest.xml'));
    const { stdout } = await run('unzip', ['-Z1', file], { maxBuffer: 16 * 1024 * 1024 });
    const names = stdout.split('\n').map(s => s.trim()).filter(Boolean);
    // The base APK's manifest is the authority; bundle JSON is only a fallback.
    const base = names.find(n => /(^|\/)base\.apk$/i.test(n)) || names.find(n => /\.apk$/i.test(n) && !/split/i.test(n));
    if (base) {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rose-pkg-'));
      try {
        await run('unzip', ['-o', '-qq', file, base, '-d', dir]);
        const p = manifestPackage(await unzipEntry(path.join(dir, base), 'AndroidManifest.xml'));
        if (p) return p;
      } finally { await fs.rm(dir, { recursive: true, force: true }); }
    }
    for (const j of ['info.json', 'manifest.json']) {
      if (!names.includes(j)) continue;
      const m = JSON.parse((await unzipEntry(file, j)).toString('utf8'));
      const p = m.pname || m.package_name;
      if (/^[\w.]+$/.test(p || '')) return p;
    }
  } catch { /* unreadable */ }
  return null;
}

/**
 * Package of every APK in an .apk or bundle: all an install of it could put on the device. Read
 * from the same extract() as adb.installBundle, which installs its own pick of them (selectApks).
 */
export async function packagesOf(file) {
  if (!(await isBundleFile(file))) return [await packageOf(file)];
  const b = await extract(file);
  try {
    return await Promise.all(b.apks.map(a => unzipEntry(a, 'AndroidManifest.xml').then(manifestPackage, () => null)));
  } finally { await b.cleanup(); }
}
