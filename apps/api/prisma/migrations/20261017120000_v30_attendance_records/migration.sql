-- v30: attendance corrections (employee asks, manager or HR decides) and a marker on corrected days. Additive only.
ALTER TABLE "attendance" ADD COLUMN IF NOT EXISTS "corrected" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS "attendance_corrections" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "checkIn" TIMESTAMP(3) NOT NULL,
    "checkOut" TIMESTAMP(3) NOT NULL,
    "recordedCheckIn" TIMESTAMP(3),
    "recordedCheckOut" TIMESTAMP(3),
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "attendance_corrections_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "attendance_corrections_orgId_status_idx" ON "attendance_corrections"("orgId", "status");
CREATE INDEX IF NOT EXISTS "attendance_corrections_userId_date_idx" ON "attendance_corrections"("userId", "date");
