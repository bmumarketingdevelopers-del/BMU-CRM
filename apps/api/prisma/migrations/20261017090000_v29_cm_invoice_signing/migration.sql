-- v29 invoices: Client Managers create and sign invoices for their own clients with their own signature and signing
-- password; each signed invoice keeps what was printed (signer role, signature, seal, name, designation).
ALTER TABLE "invoices" ADD COLUMN "signedRole" TEXT;
ALTER TABLE "invoices" ADD COLUMN "signatureFileId" TEXT;
ALTER TABLE "invoices" ADD COLUMN "sealFileId" TEXT;
ALTER TABLE "invoices" ADD COLUMN "signatoryName" TEXT;
ALTER TABLE "invoices" ADD COLUMN "signatoryDesignation" TEXT;

CREATE TABLE "signing_profiles" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "signatureFileId" TEXT,
    "passwordHash" TEXT,
    "passwordSalt" TEXT,
    "passwordSetAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "signing_profiles_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "signing_profiles_userId_key" ON "signing_profiles"("userId");
