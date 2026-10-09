import { BadRequestException } from '@nestjs/common';
import type { z } from 'zod';

/** Validates a request body with a shared Zod schema; 400 with the first issue's message on failure. */
export function parse<S extends z.ZodType>(schema: S, body: unknown): z.infer<S> {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new BadRequestException(result.error.issues[0]?.message ?? 'Invalid request');
  }
  return result.data;
}
