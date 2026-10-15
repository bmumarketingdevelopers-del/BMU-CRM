-- v23 Google Meet + Google Calendar: Meet links on meetings, attendees with replies, per-person calendar connections.
ALTER TABLE "meetings" ADD COLUMN "meetUrl" TEXT,
ADD COLUMN "googleEventId" TEXT,
ADD COLUMN "googleUserId" TEXT,
ADD COLUMN "googleError" TEXT;

CREATE TABLE "meeting_attendees" (
    "id" TEXT NOT NULL,
    "meetingId" TEXT NOT NULL,
    "userId" TEXT,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "response" TEXT NOT NULL DEFAULT 'needsAction',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "meeting_attendees_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "meeting_attendees_meetingId_email_key" ON "meeting_attendees"("meetingId", "email");
CREATE INDEX "meeting_attendees_userId_idx" ON "meeting_attendees"("userId");
ALTER TABLE "meeting_attendees" ADD CONSTRAINT "meeting_attendees_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "meetings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "calendar_connections" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'google',
    "email" TEXT NOT NULL,
    "tokenEnc" TEXT,
    "refreshEnc" TEXT,
    "tokenExpiresAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'connected',
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "calendar_connections_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "calendar_connections_userId_key" ON "calendar_connections"("userId");
