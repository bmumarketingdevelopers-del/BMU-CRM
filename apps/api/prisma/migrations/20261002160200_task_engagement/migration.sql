-- AlterTable
ALTER TABLE "tasks" ADD COLUMN     "engagementId" TEXT;


-- Link existing tasks to their engagement.
UPDATE "tasks" t SET "engagementId" = c."engagementId"
FROM "deliverables" d JOIN "cycles" c ON c."id" = d."cycleId"
WHERE t."deliverableId" = d."id" AND t."engagementId" IS NULL;
UPDATE "tasks" SET "kind" = 'planning' WHERE "flowStep" = 'planning';
