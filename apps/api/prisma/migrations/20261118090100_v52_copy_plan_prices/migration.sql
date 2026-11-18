-- v52 (data, one time): a sub-service with exactly the same name as a service in the active old price list (for
-- example "SEO") starts with that service's Starter / Growth / Premium prices and billing. Only sub-services that have
-- no price yet are touched; everything else stays empty for the admin to fill in. Undo: see docs/v52-undo.sql.
UPDATE "sub_services" AS s
SET "billing" = svc."billingType"::text,
    "starterPaise" = (SELECT t."pricePaise" FROM "service_tiers" t WHERE t."serviceId" = svc."id" AND t."tier" = 'starter'),
    "growthPaise" = (SELECT t."pricePaise" FROM "service_tiers" t WHERE t."serviceId" = svc."id" AND t."tier" = 'growth'),
    "premiumPaise" = (SELECT t."pricePaise" FROM "service_tiers" t WHERE t."serviceId" = svc."id" AND t."tier" = 'premium')
FROM "services" AS svc
JOIN "price_books" AS b ON b."id" = svc."priceBookId" AND b."status" = 'active'
WHERE svc."orgId" = s."orgId"
  AND lower(svc."name") = lower(s."name")
  AND s."starterPaise" IS NULL AND s."growthPaise" IS NULL AND s."premiumPaise" IS NULL;
