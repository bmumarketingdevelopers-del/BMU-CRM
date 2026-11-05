-- v47: service groups and sub-services; a project remembers what was ticked and its monthly fee. Additive only.
ALTER TABLE "engagements" ADD COLUMN IF NOT EXISTS "subServiceIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "engagements" ADD COLUMN IF NOT EXISTS "monthlyFeePaise" INTEGER;

CREATE TABLE IF NOT EXISTS "service_groups" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "serviceId" TEXT NOT NULL,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "service_groups_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "service_groups_orgId_name_key" ON "service_groups"("orgId", "name");

CREATE TABLE IF NOT EXISTS "sub_services" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "covers" TEXT NOT NULL DEFAULT '',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "sub_services_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "sub_services_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "service_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "sub_services_groupId_name_key" ON "sub_services"("groupId", "name");
