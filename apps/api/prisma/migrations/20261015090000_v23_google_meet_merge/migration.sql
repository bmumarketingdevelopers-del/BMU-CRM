-- v23 Google Meet merged into meeting requests: the Meet link lives in "joinUrl" (one link field), team members are
-- meeting_participants (with their Google Calendar reply) and meeting_attendees keeps the client's people and guests.
-- "meetUrl" was never filled in (no Google Calendar was connected before this change), so nothing is lost.
ALTER TABLE "meetings" DROP COLUMN "meetUrl";

ALTER TABLE "meeting_participants" ADD COLUMN "googleResponse" TEXT;
