-- v37 manual hand-off: after the client approves the plan, the Client Manager sends each deliverable to its Department
-- Head, who picks the people for every step (no automatic assignment). Additive only.
ALTER TABLE "deliverables" ADD COLUMN "handoffHeadId" TEXT;
ALTER TABLE "deliverables" ADD COLUMN "handoffById" TEXT;
ALTER TABLE "deliverables" ADD COLUMN "handoffAt" TIMESTAMP(3);
ALTER TABLE "deliverables" ADD COLUMN "handoffNote" TEXT;
ALTER TABLE "deliverables" ADD COLUMN "handoffAssignedAt" TIMESTAMP(3);
ALTER TABLE "deliverables" ADD COLUMN "handoffRemindedAt" TIMESTAMP(3);

CREATE INDEX "deliverables_handoffHeadId_handoffAssignedAt_idx" ON "deliverables"("handoffHeadId", "handoffAssignedAt");
