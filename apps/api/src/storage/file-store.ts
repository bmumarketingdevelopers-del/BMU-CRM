// v22: where uploaded and generated files live.
//
// - Supabase Storage (SUPABASE_URL + SUPABASE_SECRET_KEY set): every file is an object in one private bucket
//   (SUPABASE_STORAGE_BUCKET, default "bmu-files") under the same relative path the database already records
//   (e.g. "2026-10/<uuid>.png"). Required on Vercel, where a function has no lasting disk. Downloads redirect to a
//   short-lived signed link, so large files never pass through the function (Vercel caps responses at 4.5 MB).
// - Disk (neither set): files stay under STORAGE_DIR as before.
//
// Either way, code that needs the bytes works with a local path: uploads land in storageRoot() first (multer), and
// localFile() fetches a stored object into that folder on demand. On Vercel storageRoot() is under /tmp, a scratch
// area that lasts only as long as the function instance.
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { createWriteStream, existsSync, mkdirSync, openAsBlob } from 'node:fs';
import { rename } from 'node:fs/promises';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { NotFoundException } from '@nestjs/common';
import type { Response } from 'express';
import { isServerless } from '../runtime/process-role.js';

/** Local folder for files (disk mode) or for the working copies of stored objects (Supabase mode). */
export const storageRoot = () => {
  const dir = process.env.STORAGE_DIR?.trim() || (isServerless() ? '/tmp/bmu-storage' : 'storage');
  // resolve() even when absolute: "/tmp/x" becomes "E:\tmp\x" on Windows, and every path check compares against it.
  return isAbsolute(dir) ? resolve(dir) : resolve(process.cwd(), dir);
};

export const usesSupabaseStorage = () => !!process.env.SUPABASE_URL?.trim() && !!process.env.SUPABASE_SECRET_KEY?.trim();

export const bucketName = () => process.env.SUPABASE_STORAGE_BUCKET?.trim() || 'bmu-files';

let client: SupabaseClient | undefined;
let bucketReady: Promise<void> | undefined;

/** Server-side Supabase client (secret key: bypasses row-level security, never sent to a browser). */
export function supabase(): SupabaseClient {
  client ??= createClient(process.env.SUPABASE_URL!.trim(), process.env.SUPABASE_SECRET_KEY!.trim(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return client;
}

/** Creates the private bucket the first time it is needed. */
async function bucket() {
  bucketReady ??= (async () => {
    const sb = supabase();
    const { data } = await sb.storage.getBucket(bucketName());
    if (data) return;
    const { error } = await sb.storage.createBucket(bucketName(), { public: false });
    if (error && !/already exists/i.test(error.message)) throw new Error(`Could not create the "${bucketName()}" storage bucket: ${error.message}`);
  })().catch((e: unknown) => {
    bucketReady = undefined;
    throw e;
  });
  await bucketReady;
  return supabase().storage.from(bucketName());
}

/** A stored path as an absolute local path, refusing anything that would leave the storage folder. */
export function absPath(rel: string) {
  const root = storageRoot();
  const abs = resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + sep)) throw new NotFoundException('File not found');
  return abs;
}

/** The path the database records for a file under storageRoot() ("2026-10/x.png"), always with forward slashes. */
export const relPathOf = (abs: string) => {
  const root = storageRoot();
  return (abs.startsWith(root) ? abs.slice(root.length) : abs).replace(/\\/g, '/').replace(/^\/+/, '');
};

/** Object key for a stored path (paths saved on Windows used backslashes). */
const keyOf = (rel: string) => rel.replace(/\\/g, '/').replace(/^\/+/, '');

/** Saves a local file under `rel` (Supabase mode: uploads it; disk mode: it is already in place). */
export async function putFile(rel: string, localPath: string, contentType?: string | null) {
  if (!usesSupabaseStorage()) return;
  const b = await bucket();
  const body = await openAsBlob(localPath, { type: contentType || 'application/octet-stream' });
  const { error } = await b.upload(keyOf(rel), body, { contentType: contentType || 'application/octet-stream', upsert: true });
  if (error) throw new Error(`Could not save ${rel} to Supabase Storage: ${error.message}`);
}

/** A local path holding the file's bytes, fetched from Supabase Storage into storageRoot() when not there yet. */
export async function localFile(rel: string): Promise<string> {
  const abs = absPath(rel);
  if (existsSync(abs) || !usesSupabaseStorage()) return abs;
  const { data, error } = await (await bucket()).createSignedUrl(keyOf(rel), 300);
  if (error || !data) throw new NotFoundException('File missing in storage');
  const r = await fetch(data.signedUrl);
  if (!r.ok || !r.body) throw new NotFoundException('File missing in storage');
  mkdirSync(dirname(abs), { recursive: true });
  const part = `${abs}.part-${process.pid}-${Date.now()}`;
  await pipeline(Readable.fromWeb(r.body as WebReadableStream), createWriteStream(part));
  await rename(part, abs);
  return abs;
}

/** Deletes stored copies (local working copy too). Missing files are ignored. */
export async function removeFiles(rels: string[]) {
  if (!rels.length || !usesSupabaseStorage()) return;
  await (await bucket()).remove(rels.map(keyOf));
}

/** A link that downloads (or shows) the stored file for `expiresIn` seconds. */
export async function signedUrl(rel: string, opts: { download?: string; expiresIn?: number } = {}) {
  const { data, error } = await (await bucket()).createSignedUrl(keyOf(rel), opts.expiresIn ?? 3600, opts.download ? { download: opts.download } : undefined);
  if (error || !data) throw new NotFoundException('File missing in storage');
  return data.signedUrl;
}

/** Where a browser can upload one file straight to storage (bypassing the 4.5 MB request limit on Vercel). */
export async function signedUploadUrl(rel: string) {
  const { data, error } = await (await bucket()).createSignedUploadUrl(keyOf(rel));
  if (error || !data) throw new Error(`Could not prepare the upload: ${error?.message ?? 'no link'}`);
  return { url: data.signedUrl, token: data.token };
}

const safeName = (name: string | null | undefined) => (name ?? 'file').replace(/[^\w.\- ]/g, '_');

/**
 * Sends a stored file: from disk as before, or (Supabase) as a redirect to a short-lived signed link. `cache` is the
 * Cache-Control for the file itself in disk mode; the redirect is never cached longer than the link stays valid.
 */
export async function sendStoredFile(
  res: Response,
  file: { path: string; name?: string | null; mimeType?: string | null },
  opts: { disposition?: 'inline' | 'attachment'; cache?: string } = {},
) {
  const disposition = opts.disposition ?? 'inline';
  const abs = absPath(file.path);
  if (usesSupabaseStorage()) {
    const url = await signedUrl(file.path, { download: disposition === 'attachment' ? safeName(file.name) : undefined, expiresIn: 3600 });
    res.setHeader('Cache-Control', opts.cache?.includes('no-store') ? 'no-store' : 'private, max-age=300');
    return res.redirect(302, url);
  }
  res.setHeader('Content-Disposition', `${disposition}; filename="${safeName(file.name)}"`);
  res.setHeader('Cache-Control', opts.cache ?? 'private, max-age=3600');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (file.mimeType) res.type(file.mimeType);
  res.sendFile(abs, (err) => {
    if (err && !res.headersSent) res.status(404).json({ message: 'File missing on disk' });
  });
}
