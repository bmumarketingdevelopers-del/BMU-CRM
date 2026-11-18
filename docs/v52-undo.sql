-- Undo for v52 (migrations 20261118090000_v52_price_list_clients_documents and 20261118090100_v52_copy_plan_prices).
-- Run it only together with reverting the v52 code: the app reads these tables and columns.
-- It removes the price list prices, bundles, industries, client services and the new client and invoice fields.
-- Data in them is lost; take a backup first (pg_dump) if any of it matters.
BEGIN;

DROP TABLE IF EXISTS "client_services";
DROP TRIGGER IF EXISTS "service_bundles_check_members" ON "service_bundles";
DROP FUNCTION IF EXISTS "service_bundles_check_members"();
DROP TABLE IF EXISTS "service_bundles";
DROP TABLE IF EXISTS "industries";

ALTER TABLE "sub_services" DROP CONSTRAINT IF EXISTS "sub_services_billing_check";
ALTER TABLE "sub_services" DROP CONSTRAINT IF EXISTS "sub_services_prices_check";
ALTER TABLE "sub_services" DROP COLUMN IF EXISTS "billing",
  DROP COLUMN IF EXISTS "starterPaise",
  DROP COLUMN IF EXISTS "growthPaise",
  DROP COLUMN IF EXISTS "premiumPaise";

ALTER TABLE "invoices" DROP CONSTRAINT IF EXISTS "invoices_gstRatePct_check";
ALTER TABLE "invoices" DROP COLUMN IF EXISTS "gstRatePct",
  DROP COLUMN IF EXISTS "doc";

ALTER TABLE "client_orgs" DROP CONSTRAINT IF EXISTS "client_orgs_clientStatus_check";
ALTER TABLE "client_orgs" DROP COLUMN IF EXISTS "clientStatus",
  DROP COLUMN IF EXISTS "website",
  DROP COLUMN IF EXISTS "departmentId",
  DROP COLUMN IF EXISTS "onboardingDate",
  DROP COLUMN IF EXISTS "nextFollowUpAt",
  DROP COLUMN IF EXISTS "importantNotes",
  DROP COLUMN IF EXISTS "createdById";

-- So Prisma does not think these migrations are still applied.
DELETE FROM "_prisma_migrations" WHERE "migration_name" IN ('20261118090000_v52_price_list_clients_documents', '20261118090100_v52_copy_plan_prices');

COMMIT;
