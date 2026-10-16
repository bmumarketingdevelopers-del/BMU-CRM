-- v24 meetings: a Client Manager can bring several departments into one meeting (each Department Head represents
-- their department and adds team members working on the client's projects), and another branch's Branch Manager can
-- be added by the Client Manager or the client's own Branch Manager.
ALTER TABLE "meeting_participants" ADD COLUMN "departmentId" TEXT;
ALTER TABLE "meeting_participants" ADD COLUMN "addedById" TEXT;

-- Existing Department Heads represent the one department their meeting had.
UPDATE "meeting_participants" p SET "departmentId" = m."departmentId"
FROM "meetings" m
WHERE p."meetingId" = m."id" AND p."role" = 'department_head' AND m."departmentId" IS NOT NULL;
