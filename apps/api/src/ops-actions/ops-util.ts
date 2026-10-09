// v11 ops: small helpers shared by the ops action services.
import { createHash } from 'node:crypto';
import { createReadStream, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { extname, join } from 'node:path';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import type { Me } from '@bmu/shared';
import { storageRoot } from '../production/production.controller.js';

export const hasRole = (me: { roles: string[] }, ...roles: string[]) => me.roles.some((r) => roles.includes(r));
export const isFounderAdmin = (me: { roles: string[] }) => hasRole(me, 'founder', 'admin');
export const isLeadership = (me: { roles: string[] }) => hasRole(me, 'founder', 'admin', 'am_lead');
export const isStaff = (me: Me) => me.type === 'staff';

/** Last 10 digits of a phone number ("" when there are fewer). */
export const phoneDigits = (s?: string | null) => {
  const d = (s ?? '').replace(/\D/g, '').slice(-10);
  return d.length === 10 ? d : '';
};
export const lc = (s?: string | null) => (s ?? '').trim().toLowerCase();

export type OpsUpload = { path: string; originalname: string; mimetype: string; size: number };

/** Multer: files go under STORAGE_DIR/files/<yyyy-mm>, up to 200 MB. */
export const opsUpload = FileInterceptor('file', {
  storage: diskStorage({
    destination: (_req, _file, cb) => {
      const dir = join(storageRoot(), 'files', new Date().toISOString().slice(0, 7));
      mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (_req, file, cb) => cb(null, `${randomUUID()}${extname(file.originalname).toLowerCase().slice(0, 10)}`),
  }),
  limits: { fileSize: 200 * 1024 * 1024 },
});

export const relPath = (abs: string) => {
  const root = storageRoot();
  return abs.startsWith(root) ? abs.slice(root.length).replace(/^[/\\]+/, '') : abs;
};

export function sha256(path: string) {
  return new Promise<string>((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(path)
      .on('data', (c) => h.update(c))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject);
  });
}

const dFmt = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
const dtFmt = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' });
export const day = (d: Date) => dFmt.format(d);
export const dayTime = (d: Date) => dtFmt.format(d);
/** "2026-10-05" → that day 6 pm IST. */
export const istDay = (ymd: string) => new Date(`${ymd}T18:00:00+05:30`);
export const todayIst = () => new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
