-- v33: built-in dashboards remember which sections they have offered, so sections added later appear. Additive only.
ALTER TABLE "dashboards" ADD COLUMN IF NOT EXISTS "knownSections" JSONB;
