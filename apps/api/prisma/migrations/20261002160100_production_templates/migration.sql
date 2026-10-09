-- AlterTable
ALTER TABLE "checklist_templates" ADD COLUMN     "key" TEXT;

-- AlterTable
ALTER TABLE "flow_templates" ADD COLUMN     "active" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "deliverableTypes" TEXT[],
ADD COLUMN     "key" TEXT NOT NULL DEFAULT 'general';

