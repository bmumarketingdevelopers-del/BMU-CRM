// v22: uploads that work within Vercel's 4.5 MB request limit, with no change to the upload endpoints themselves.
//
// 1. The browser asks POST /storage/uploads for a one-time Supabase Storage upload link (plus a signed ticket).
// 2. It uploads the file straight to Supabase Storage with that link.
// 3. It calls the usual upload endpoint with the other form fields as JSON and the header X-BMU-Stored-File.
//    storedUploadMiddleware checks the ticket, fetches the object into storageRoot() and sets req.file exactly as
//    multer would have (multer leaves non-multipart requests alone), so every handler keeps working unchanged.
//
// Small multipart uploads (e.g. from the phone app) still work: PersistUploadsInterceptor copies whatever multer
// saved locally into Supabase Storage once the handler has succeeded.
import { BadRequestException, Body, Controller, Injectable, Module, Post, type CallHandler, type ExecutionContext, type NestInterceptor } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { extname } from 'node:path';
import type { NextFunction, Request, Response } from 'express';
import { from, mergeMap, type Observable } from 'rxjs';
import { z } from 'zod';
import { ClientIp, Public } from '../common/decorators.js';
import { publicLimit } from '../common/rate-limit.js';
import { parse } from '../common/zod.js';
import { localFile, putFile, relPathOf, signedUploadUrl, storageRoot, usesSupabaseStorage } from './file-store.js';

export const STORED_FILE_HEADER = 'x-bmu-stored-file';
const TICKET_MS = 60 * 60_000;
/** Largest single upload (the biggest multer limit). Supabase's per-file limit may be lower: 50 MB on the Free plan. */
const MAX_BYTES = 500 * 1024 ** 2;

type StoredFileRef = { field: string; key: string; name: string; type: string; exp: number; sig: string };
type UploadedFile = Express.Multer.File & { stored?: boolean };

const secret = () => process.env.JWT_SECRET || 'dev-only-change-me';
const sign = (key: string, exp: number) => createHmac('sha256', secret()).update(`upload:${key}:${exp}`).digest('base64url');

const uploadRequestSchema = z.object({
  name: z.string().trim().min(1).max(255),
  type: z.string().trim().max(150).optional(),
  size: z.number().int().nonnegative().max(MAX_BYTES).optional(),
});

@Public()
@Controller('storage')
export class StorageController {
  /** A one-time link to upload one file straight to storage. `{ direct: false }` when files stay on the API's disk. */
  @Post('uploads')
  async createUpload(@Body() body: unknown, @ClientIp() ip?: string) {
    if (!usesSupabaseStorage()) return { direct: false as const };
    // Public forms (enquiries, proposals) upload too, so links are limited per visitor like other public endpoints.
    publicLimit(`upload:${ip ?? '?'}`, 120, 10 * 60_000, ip);
    const input = parse(uploadRequestSchema, body);
    const key = `uploads/${new Date().toISOString().slice(0, 7)}/${randomUUID()}${extname(input.name).toLowerCase().slice(0, 10)}`;
    const { url, token } = await signedUploadUrl(key);
    const exp = Date.now() + TICKET_MS;
    // The publishable key is public by design; Supabase accepts it next to the one-time token.
    const apikey = process.env.SUPABASE_PUBLISHABLE_KEY?.trim() || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim() || undefined;
    return { direct: true as const, key, url, token, exp, sig: sign(key, exp), apikey };
  }
}

/** Express middleware (see app-setup.ts): turns X-BMU-Stored-File into req.file. */
export async function storedUploadMiddleware(req: Request, res: Response, next: NextFunction) {
  const header = req.headers[STORED_FILE_HEADER];
  if (typeof header !== 'string' || !header) return next();
  try {
    let ref: StoredFileRef;
    try {
      ref = JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as StoredFileRef;
    } catch {
      throw new BadRequestException('Unreadable stored-file reference');
    }
    const good = sign(String(ref.key), Number(ref.exp));
    const ok = typeof ref.sig === 'string' && ref.sig.length === good.length && timingSafeEqual(Buffer.from(ref.sig), Buffer.from(good));
    if (!ok || !String(ref.key).startsWith('uploads/')) throw new BadRequestException('This upload link is not valid');
    if (Number(ref.exp) < Date.now()) throw new BadRequestException('This upload has expired. Please upload the file again');
    const path = await localFile(ref.key);
    const size = (await stat(path)).size;
    if (size > MAX_BYTES) throw new BadRequestException('That file is too large');
    const file: UploadedFile = {
      fieldname: ref.field || 'file',
      originalname: String(ref.name || 'file').slice(0, 255),
      encoding: '7bit',
      mimetype: String(ref.type || 'application/octet-stream').slice(0, 150),
      size,
      destination: storageRoot(),
      filename: ref.key.split('/').pop()!,
      path,
      stored: true,
    } as UploadedFile;
    (req as Request & { file?: UploadedFile }).file = file;
    next();
  } catch (e) {
    const status = e instanceof BadRequestException ? 400 : ((e as { status?: number }).status ?? 500);
    res.status(status).json({ statusCode: status, message: (e as Error).message || 'Upload failed' });
  }
}

/** After a successful upload request, saves the files multer put on local disk into Supabase Storage. */
@Injectable()
export class PersistUploadsInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (ctx.getType() !== 'http' || !usesSupabaseStorage()) return next.handle();
    const req = ctx.switchToHttp().getRequest<Request & { file?: UploadedFile; files?: UploadedFile[] | Record<string, UploadedFile[]> }>();
    return next.handle().pipe(
      mergeMap((result) =>
        from(
          (async () => {
            const files = [req.file, ...(Array.isArray(req.files) ? req.files : Object.values(req.files ?? {}).flat())].filter((f) => !!f?.path && !(f as UploadedFile).stored) as UploadedFile[];
            const root = storageRoot();
            for (const f of files) if (f.path.startsWith(root)) await putFile(relPathOf(f.path), f.path, f.mimetype);
            return result;
          })(),
        ),
      ),
    );
  }
}

@Module({
  controllers: [StorageController],
  providers: [{ provide: APP_INTERCEPTOR, useClass: PersistUploadsInterceptor }],
})
export class StorageModule {}
