-- v28 invoices: the seal and signature are added with the signing password; until then delivery to the client is held.
ALTER TABLE "invoices" ADD COLUMN "signedAt" TIMESTAMP(3);
ALTER TABLE "invoices" ADD COLUMN "signedById" TEXT;
ALTER TABLE "invoices" ADD COLUMN "deliveryHeldAt" TIMESTAMP(3);
