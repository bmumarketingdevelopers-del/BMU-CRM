-- AlterEnum
ALTER TYPE "DeliverableStatus" ADD VALUE 'qc_passed';

-- AlterTable
ALTER TABLE "deliverables" ADD COLUMN     "departmentId" TEXT,
ADD COLUMN     "dueAt" TIMESTAMP(3),
ADD COLUMN     "flowKey" TEXT;

-- AlterTable
ALTER TABLE "files" ADD COLUMN     "mimeType" TEXT,
ADD COLUMN     "name" TEXT,
ADD COLUMN     "sizeBytes" INTEGER;

-- AlterTable
ALTER TABLE "tasks" ADD COLUMN     "completedAt" TIMESTAMP(3),
ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'work',
ADD COLUMN     "role" TEXT,
ADD COLUMN     "sort" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "startedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "versions" ADD COLUMN     "note" TEXT,
ADD COLUMN     "sentById" TEXT,
ADD COLUMN     "sentToClientAt" TIMESTAMP(3);

