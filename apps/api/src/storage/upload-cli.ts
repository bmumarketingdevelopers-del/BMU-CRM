// `pnpm storage:upload`: copies the files the database knows about from this computer into Supabase Storage, once,
// when moving to Vercel. Looks for each file under STORAGE_DIR (default apps/api/storage) and then apps/api itself
// (where the demo seed keeps its pictures). Safe to run again: files already in storage are overwritten.
import 'dotenv/config';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { PrismaService } from '../prisma/prisma.service.js';
import { putFile, storageRoot, usesSupabaseStorage } from './file-store.js';

if (!usesSupabaseStorage()) {
  console.log('Set SUPABASE_URL and SUPABASE_SECRET_KEY in apps/api/.env first.');
  process.exit(1);
}

const prisma = new PrismaService();
const roots = [storageRoot(), process.cwd()];
const files = await prisma.file.findMany({ where: { kind: { not: 'link' } }, select: { path: true, mimeType: true } });
let copied = 0;
const missing: string[] = [];
for (const f of files) {
  if (/^https?:\/\//.test(f.path)) continue;
  const local = roots.map((r) => resolve(r, f.path)).find((p) => existsSync(p));
  if (!local) {
    missing.push(f.path);
    continue;
  }
  await putFile(f.path, local, f.mimeType);
  copied++;
  if (copied % 25 === 0) console.log(`  ${copied} copied…`);
}
console.log(`Copied ${copied} file(s) to Supabase Storage.`);
if (missing.length) console.log(`${missing.length} file(s) were not found on this computer, e.g. ${missing.slice(0, 5).join(', ')}`);
await prisma.$disconnect();
