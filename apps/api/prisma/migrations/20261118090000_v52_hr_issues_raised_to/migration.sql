-- v52 (additive): who an issue is raised with. Existing issues were all raised with HR.
ALTER TABLE "hr_issues" ADD COLUMN "raisedTo" TEXT NOT NULL DEFAULT 'hr';
