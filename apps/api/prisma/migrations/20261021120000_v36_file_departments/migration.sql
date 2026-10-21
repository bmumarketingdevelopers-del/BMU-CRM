-- v36: files belong to a department (work versions: the deliverable's; team uploads: the uploader's). Additive.
ALTER TABLE "files" ADD COLUMN IF NOT EXISTS "departmentId" TEXT;
CREATE INDEX IF NOT EXISTS "files_orgId_departmentId_idx" ON "files"("orgId", "departmentId");

-- Work versions take the department of their deliverable.
UPDATE "files" f SET "departmentId" = d."departmentId"
FROM "versions" v JOIN "deliverables" d ON d."id" = v."deliverableId"
WHERE v."fileId" = f."id" AND f."departmentId" IS NULL AND d."departmentId" IS NOT NULL;

-- Team uploads take the uploader's department (client uploads, chat files and payment proofs stay "Client" files).
UPDATE "files" f SET "departmentId" = u."departmentId"
FROM "users" u
WHERE u."id" = f."uploadedById" AND u."type" = 'staff' AND u."departmentId" IS NOT NULL
  AND f."departmentId" IS NULL AND f."kind" <> 'message_attachment' AND f."folder" <> 'from_client'
  AND NOT (f."tags" && ARRAY['payment-proof','invoice-signature','invoice-seal','cm-signature']::text[]);
