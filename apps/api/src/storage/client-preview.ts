// v37: how a client gets a one-time project's work before the final payment: images and PDFs as watermarked previews,
// videos streamed for the in-app player (which shows an on-screen watermark and no download), anything else held back.
import { readFile } from 'node:fs/promises';
import { ForbiddenException } from '@nestjs/common';
import type { Response } from 'express';
import { localFile, sendStoredFile } from './file-store.js';
import { watermarked } from './watermark.js';

export async function sendClientPreview(res: Response, file: { id: string; path: string; name: string | null; mimeType: string | null; sizeBytes: number | null }) {
  res.setHeader('Cache-Control', 'no-store');
  if ((file.mimeType ?? '').startsWith('video/')) {
    res.setHeader('X-BMU-Preview', 'video');
    return sendStoredFile(res, file, { disposition: 'inline', cache: 'no-store' });
  }
  const out = await watermarked(`${file.id}:${file.sizeBytes ?? 0}`, file.mimeType, await readFile(await localFile(file.path)));
  if (!out) throw new ForbiddenException('This file opens after the final payment. Ask your Client Manager for a preview.');
  const base = (file.name ?? 'file').replace(/[^\w.-]+/g, '_').replace(/\.[^.]+$/, '');
  res.setHeader('X-BMU-Preview', 'watermarked');
  res.setHeader('Content-Type', out.type);
  res.setHeader('Content-Disposition', `inline; filename="preview-${base}.${out.type === 'application/pdf' ? 'pdf' : 'jpg'}"`);
  return res.end(out.body);
}
