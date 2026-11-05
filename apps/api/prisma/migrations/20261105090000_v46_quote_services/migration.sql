-- v46: a quotation can be for several of the client's services. Additive only.
ALTER TABLE "quotations" ADD COLUMN IF NOT EXISTS "engagementIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
UPDATE "quotations" SET "engagementIds" = ARRAY["engagementId"] WHERE "engagementId" IS NOT NULL AND cardinality("engagementIds") = 0;
