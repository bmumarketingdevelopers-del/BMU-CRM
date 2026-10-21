// v39: how a client gets a one-time project's work before the final payment: view only. Pictures, PDFs and videos
// are sent as they are for viewing in the app (never as a download, never cached); anything a browser can't show
// waits for the payment. Downloads (?download=1) and zips are refused before this is reached.
import { ForbiddenException } from '@nestjs/common';
import type { Response } from 'express';
import { sendStoredFile } from './file-store.js';

const VIEWABLE = /^(image\/(png|jpe?g|gif|webp|bmp|avif)|video\/|application\/pdf$)/i;

export async function sendClientPreview(res: Response, file: { id: string; path: string; name: string | null; mimeType: string | null; sizeBytes: number | null }) {
  if (!VIEWABLE.test(file.mimeType ?? '')) throw new ForbiddenException('This file opens after the final payment.');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-BMU-Preview', 'view');
  return sendStoredFile(res, file, { disposition: 'inline', cache: 'no-store' });
}
