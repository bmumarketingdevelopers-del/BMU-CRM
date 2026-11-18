-- v52 (additive): price list with plan prices, bundles and industries; client details and the client's services with
-- plans; the shared quotation / invoice form (GST rate and document parts on invoices). Nothing is removed or renamed.
-- Undo: see docs/v52-undo.sql.

-- Clients: status, website, department, dates, notes, who added it. Clients made before v52 are "active".
ALTER TABLE "client_orgs" ADD COLUMN     "clientStatus" TEXT NOT NULL DEFAULT 'active',
ADD COLUMN     "createdById" TEXT,
ADD COLUMN     "departmentId" TEXT,
ADD COLUMN     "importantNotes" TEXT,
ADD COLUMN     "nextFollowUpAt" TIMESTAMP(3),
ADD COLUMN     "onboardingDate" TIMESTAMP(3),
ADD COLUMN     "website" TEXT;
ALTER TABLE "client_orgs" ADD CONSTRAINT "client_orgs_clientStatus_check" CHECK ("clientStatus" IN ('lead', 'onboarding', 'active', 'on_hold', 'inactive'));

-- Invoices: one GST rate for every item (0 = no GST) and the document parts.
ALTER TABLE "invoices" ADD COLUMN     "doc" JSONB,
ADD COLUMN     "gstRatePct" INTEGER;
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_gstRatePct_check" CHECK ("gstRatePct" IS NULL OR "gstRatePct" IN (0, 5, 12, 18, 28));

-- Sub-services: billing and the three plan prices before GST (empty = plan not offered).
ALTER TABLE "sub_services" ADD COLUMN     "billing" TEXT NOT NULL DEFAULT 'monthly',
ADD COLUMN     "growthPaise" INTEGER,
ADD COLUMN     "premiumPaise" INTEGER,
ADD COLUMN     "starterPaise" INTEGER;
ALTER TABLE "sub_services" ADD CONSTRAINT "sub_services_billing_check" CHECK ("billing" IN ('monthly', 'one_time', 'per_unit'));
ALTER TABLE "sub_services" ADD CONSTRAINT "sub_services_prices_check" CHECK (COALESCE("starterPaise", 0) >= 0 AND COALESCE("growthPaise", 0) >= 0 AND COALESCE("premiumPaise", 0) >= 0);

-- Bundles of sub-services.
CREATE TABLE "service_bundles" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "subServiceIds" TEXT[],
    "savingPct" INTEGER NOT NULL DEFAULT 10,
    "selectable" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "service_bundles_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "service_bundles_size_check" CHECK (cardinality("subServiceIds") BETWEEN 2 AND 20),
    CONSTRAINT "service_bundles_saving_check" CHECK ("savingPct" BETWEEN 0 AND 90)
);
CREATE INDEX "service_bundles_orgId_idx" ON "service_bundles"("orgId");
CREATE UNIQUE INDEX "service_bundles_orgId_name_ci_key" ON "service_bundles"("orgId", lower("name"));

-- Every member is a sub-service of the same organisation, each used once.
CREATE FUNCTION "service_bundles_check_members"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT count(DISTINCT m) FROM unnest(NEW."subServiceIds") AS m) <> cardinality(NEW."subServiceIds") THEN
    RAISE EXCEPTION 'A bundle lists each sub-service once' USING ERRCODE = 'check_violation';
  END IF;
  IF (SELECT count(*) FROM "sub_services" s WHERE s."id" = ANY (NEW."subServiceIds") AND s."orgId" = NEW."orgId") <> cardinality(NEW."subServiceIds") THEN
    RAISE EXCEPTION 'A bundle can only hold sub-services from the price list' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "service_bundles_check_members" BEFORE INSERT OR UPDATE OF "subServiceIds", "orgId" ON "service_bundles"
  FOR EACH ROW EXECUTE FUNCTION "service_bundles_check_members"();

-- Industries.
CREATE TABLE "industries" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "industries_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "industries_orgId_idx" ON "industries"("orgId");
CREATE UNIQUE INDEX "industries_orgId_name_ci_key" ON "industries"("orgId", lower("name"));

-- What a client has bought: one row per sub-service OR bundle (never both), with its plan.
CREATE TABLE "client_services" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "clientOrgId" TEXT NOT NULL,
    "subServiceId" TEXT,
    "bundleId" TEXT,
    "plan" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "startDate" TIMESTAMP(3),
    "name" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "client_services_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "client_services_one_item_check" CHECK (num_nonnulls("subServiceId", "bundleId") = 1),
    CONSTRAINT "client_services_plan_check" CHECK ("plan" IS NULL OR "plan" IN ('starter', 'growth', 'premium')),
    CONSTRAINT "client_services_status_check" CHECK ("status" IN ('active', 'paused', 'ended'))
);
CREATE INDEX "client_services_clientOrgId_status_idx" ON "client_services"("clientOrgId", "status");

ALTER TABLE "client_services" ADD CONSTRAINT "client_services_clientOrgId_fkey" FOREIGN KEY ("clientOrgId") REFERENCES "client_orgs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "client_services" ADD CONSTRAINT "client_services_subServiceId_fkey" FOREIGN KEY ("subServiceId") REFERENCES "sub_services"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "client_services" ADD CONSTRAINT "client_services_bundleId_fkey" FOREIGN KEY ("bundleId") REFERENCES "service_bundles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
