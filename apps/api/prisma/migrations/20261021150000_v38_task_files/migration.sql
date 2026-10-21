-- v38: files sent on a task (File ids). Additive.
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "attachments" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
