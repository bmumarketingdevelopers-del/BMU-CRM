-- v42 (additive): sessions carry their own end date, which follows Command Centre > Security > session length, and
-- Google sign-in is tied to the Google account a person first used.
ALTER TABLE "user_sessions" ADD COLUMN "expiresAt" TIMESTAMP(3);
-- Sessions from before v42 keep the old fixed 30 days.
UPDATE "user_sessions" SET "expiresAt" = "createdAt" + INTERVAL '30 days' WHERE "expiresAt" IS NULL;

ALTER TABLE "users" ADD COLUMN "googleSub" TEXT;
ALTER TABLE "users" ADD COLUMN "googleEmail" TEXT;
