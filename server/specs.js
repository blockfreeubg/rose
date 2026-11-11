// What this machine can do (shared by hub and node): a node reports it to the hub in its hello, and
// MAX_SESSIONS=auto sizes the machine from it. No imports from config.js (config.js uses this).
import fs from 'node:fs';
import os from 'node:os';

const MB = 1024 * 1024;
const read = f => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
const exists = f => { try { fs.accessSync(f); return true; } catch { return false; } };

/** { cpuModel, threads, ramMb, gpu, binder, uhid, kernel, arch, wsl } */
export function detect() {
  const kernel = os.release();
  const cpuModel = (read('/proc/cpuinfo').match(/^model name\s*:\s*(.+)$/m)?.[1] || os.cpus()[0]?.model || 'unknown').trim().slice(0, 100);
  let gpu = false;
  try { gpu = fs.readdirSync('/dev/dri').some(n => n.startsWith('renderD')); } catch {}
  // Redroid needs binder: binderfs built in (or as a module), or the binder_linux module loaded.
  const binder = /\bbinder\b/.test(read('/proc/filesystems')) || exists('/dev/binderfs') || exists('/dev/binder')
    || exists('/sys/module/binder_linux');
  return {
    cpuModel, threads: os.cpus().length, ramMb: Math.round(os.totalmem() / MB),
    gpu, binder, uhid: exists('/dev/uhid') || exists('/sys/module/uhid'),
    kernel, arch: os.arch(), wsl: /microsoft|wsl/i.test(kernel),
  };
}

/**
 * Sessions this machine can run at once: about SESSION_MEMORY_MB + 512 MB of RAM and SESSION_CPUS
 * threads each, after keeping 2 GB and 1 thread for the host. 0 = too small to host anything.
 */
export function autoMaxSessions(s = detect()) {
  const memMb = Number(process.env.SESSION_MEMORY_MB) || 2048;
  const cpus = Number(process.env.SESSION_CPUS) || 2;
  const byRam = Math.floor((s.ramMb - 2048) / (memMb + 512));
  const byCpu = Math.floor((s.threads - 1) / cpus);
  return Math.max(0, Math.min(16, byRam, byCpu));
}
