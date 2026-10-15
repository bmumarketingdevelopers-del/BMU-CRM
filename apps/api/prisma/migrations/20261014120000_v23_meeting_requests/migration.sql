-- v23 meeting requests: clients ask for a meeting (any time zone), the Client Manager brings in a Department Head
-- and/or the Founder to confirm, then the Branch Manager, Founder, department and client are told it is fixed.
ALTER TABLE "meetings" ADD COLUMN "timeZone" TEXT NOT NULL DEFAULT 'Asia/Kolkata';
ALTER TABLE "meetings" ADD COLUMN "departmentId" TEXT;
ALTER TABLE "meetings" ADD COLUMN "joinUrl" TEXT;
ALTER TABLE "meetings" ADD COLUMN "rescheduledAt" TIMESTAMP(3);

CREATE TABLE "meeting_participants" (
    "id" TEXT NOT NULL,
    "meetingId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "proposedStartAt" TIMESTAMP(3),
    "note" TEXT,
    "respondedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "meeting_participants_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "meeting_participants_meetingId_userId_key" ON "meeting_participants"("meetingId", "userId");
CREATE INDEX "meeting_participants_userId_status_idx" ON "meeting_participants"("userId", "status");

ALTER TABLE "meeting_participants" ADD CONSTRAINT "meeting_participants_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "meetings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
