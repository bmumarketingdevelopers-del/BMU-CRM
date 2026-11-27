-- v56: a client's sub-service or bundle without plan prices can carry its own amount and billing (monthly | one_time).
ALTER TABLE "client_services" ADD COLUMN "customPricePaise" INTEGER;
ALTER TABLE "client_services" ADD COLUMN "customBilling" TEXT;
