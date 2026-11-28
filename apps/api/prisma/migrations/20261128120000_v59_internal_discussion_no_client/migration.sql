-- v59: an internal discussion does not have to be about a client. Existing discussions keep their client.
-- Undo (only while no discussion is without a client): ALTER TABLE "threads" ALTER COLUMN "clientOrgId" SET NOT NULL;
ALTER TABLE "threads" ALTER COLUMN "clientOrgId" DROP NOT NULL;
