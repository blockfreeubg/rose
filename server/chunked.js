import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CHUNK_LIMIT = 16 * 1024 * 1024;
const MAX_TOTAL = 8 * 1024 ** 3;
const dir = path.join(os.tmpdir(), 'rose-chunks');
const fileFor = id => path.join(dir, id);
const validId = id => /^[a-f0-9]{24}$/.test(String(id));
const busy = new Set(); 

export function router() {
  const r = express.Router();

  r.post('/uploads', async (req, res) => {
    await fs.mkdir(dir, { recursive: true });
    const id = crypto.randomBytes(12).toString('hex');
    await fs.writeFile(fileFor(id), '');
    res.json({ id });
  });

  r.put('/uploads/:id', express.raw({ type: () => true, limit: CHUNK_LIMIT }), async (req, res) => {
    const { id } = req.params;
    if (!validId(id)) return res.status(400).json({ error: 'bad upload id' });
    if (busy.has(id)) return res.status(409).json({ error: 'chunk already in progress' });
    busy.add(id);
    try {
      const st = await fs.stat(fileFor(id)).catch(() => null);
      if (!st) return res.status(404).json({ error: 'upload expired, please retry' });
      const offset = Number(req.query.offset);
      if (offset + req.body.length <= st.size) return res.json({ size: st.size });
      if (offset !== st.size) return res.status(409).json({ error: `offset mismatch (have ${st.size})`, size: st.size });
      if (st.size + req.body.length > MAX_TOTAL) return res.status(413).json({ error: 'file too large' });
      await new Promise((ok, fail) => {
        const w = createWriteStream(fileFor(id), { flags: 'a' });
        w.on('error', fail).on('finish', ok);
        w.end(req.body);
      });
      res.json({ size: st.size + req.body.length });
    } finally {
      busy.delete(id);
    }
  });

  r.get('/uploads/:id', async (req, res) => {
    if (!validId(req.params.id)) return res.status(400).json({ error: 'bad upload id' });
    const st = await fs.stat(fileFor(req.params.id)).catch(() => null);
    if (!st) return res.status(404).json({ error: 'upload expired' });
    res.json({ size: st.size });
  });

  r.delete('/uploads/:id', async (req, res) => {
    if (validId(req.params.id)) await fs.rm(fileFor(req.params.id), { force: true });
    res.json({ ok: true });
  });

  setInterval(async () => {
    for (const f of await fs.readdir(dir).catch(() => [])) {
      const st = await fs.stat(path.join(dir, f)).catch(() => null);
      if (st && Date.now() - st.mtimeMs > 24 * 3600_000) await fs.rm(path.join(dir, f), { force: true });
    }
  }, 600_000).unref();

  return r;
}

export function adopt(field) {
  return async (req, res, next) => {
    const id = req.body?.uploadId;
    if (!id) return next();
    if (!validId(id)) return res.status(400).json({ error: 'bad upload id' });
    const p = fileFor(id);
    const st = await fs.stat(p).catch(() => null);
    if (!st || !st.size) return res.status(404).json({ error: 'upload not found or empty, please retry' });
    const file = { fieldname: field, originalname: path.basename(String(req.body.uploadName || 'upload.bin')), path: p, size: st.size };
    req.files = { ...(req.files || {}), [field]: [file] };
    req.file = file;
    next();
  };
}
