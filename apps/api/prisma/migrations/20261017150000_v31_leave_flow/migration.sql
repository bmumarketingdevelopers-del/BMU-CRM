-- v31: paid and unpaid days on each leave request (1 paid casual + 1 paid sick a month). Additive only.
ALTER TABLE "leave_requests" ADD COLUMN IF NOT EXISTS "paidDays" INTEGER;
ALTER TABLE "leave_requests" ADD COLUMN IF NOT EXISTS "unpaidDays" INTEGER;
