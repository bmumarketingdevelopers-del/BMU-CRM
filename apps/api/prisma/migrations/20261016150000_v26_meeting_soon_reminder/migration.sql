-- v26 meetings: a second reminder 15 minutes before (everyone taking part, with the join link), sent once.
ALTER TABLE "meetings" ADD COLUMN "soonReminderAt" TIMESTAMP(3);
