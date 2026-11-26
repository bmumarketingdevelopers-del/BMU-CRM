-- v53: who has a discussion open right now (no notifications while they read it).
ALTER TABLE "thread_reads" ADD COLUMN "viewingAt" TIMESTAMP(3);
