-- v49: the client's signature, seal or signed copy on a quotation, requested changes and "I have paid" notes. Additive only.
ALTER TABLE "quotations" ADD COLUMN IF NOT EXISTS "clientSignatureFileId" TEXT;
ALTER TABLE "quotations" ADD COLUMN IF NOT EXISTS "clientSealFileId" TEXT;
ALTER TABLE "quotations" ADD COLUMN IF NOT EXISTS "signedCopyFileId" TEXT;
ALTER TABLE "quotations" ADD COLUMN IF NOT EXISTS "changeRequest" TEXT;
ALTER TABLE "quotations" ADD COLUMN IF NOT EXISTS "paymentNotes" JSONB NOT NULL DEFAULT '[]';
