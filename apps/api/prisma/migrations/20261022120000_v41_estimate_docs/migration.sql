-- v41: requirement documents the Client Manager sends with a request to Department Heads. Additive.
ALTER TABLE "project_estimates" ADD COLUMN IF NOT EXISTS "docFileIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
