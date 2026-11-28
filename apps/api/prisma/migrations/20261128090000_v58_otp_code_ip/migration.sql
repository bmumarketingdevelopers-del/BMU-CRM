-- v58: sign-in code limits kept in the database (they held only per server before): the network that asked.
ALTER TABLE "otp_codes" ADD COLUMN "ip" TEXT;
CREATE INDEX "otp_codes_ip_createdAt_idx" ON "otp_codes"("ip", "createdAt");
