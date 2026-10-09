-- AlterTable
ALTER TABLE "audit_events" ADD COLUMN     "hash" TEXT,
ADD COLUMN     "prevHash" TEXT,
ADD COLUMN     "seq" INTEGER;

-- AlterTable
ALTER TABLE "custom_field_defs" ADD COLUMN     "hiddenFrom" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "readOnlyFor" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "user_sessions" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "userAgent" TEXT,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "user_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_totp" (
    "userId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "secretEnc" TEXT NOT NULL,
    "enabledAt" TIMESTAMP(3),
    "recoveryCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "lastUsedStep" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_totp_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "passkeys" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL,
    "publicKey" BYTEA NOT NULL,
    "counter" INTEGER NOT NULL DEFAULT 0,
    "transports" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),

    CONSTRAINT "passkeys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consents" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "purpose" TEXT NOT NULL,
    "granted" BOOLEAN NOT NULL DEFAULT true,
    "source" TEXT NOT NULL,
    "noticeVersion" TEXT NOT NULL,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "withdrawnAt" TIMESTAMP(3),

    CONSTRAINT "consents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "data_requests" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT,
    "requesterName" TEXT NOT NULL,
    "requesterEmail" TEXT NOT NULL,
    "details" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "dueAt" TIMESTAMP(3) NOT NULL,
    "assigneeId" TEXT,
    "resolution" TEXT,
    "completedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "data_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "retention_rules" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "recordType" TEXT NOT NULL,
    "keepDays" INTEGER NOT NULL,
    "action" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastRunAt" TIMESTAMP(3),
    "lastCount" INTEGER,

    CONSTRAINT "retention_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "forecasts" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "period" TEXT NOT NULL DEFAULT '',
    "value" DOUBLE PRECISION NOT NULL,
    "score" INTEGER,
    "reasons" JSONB NOT NULL DEFAULT '[]',
    "meta" JSONB,
    "source" TEXT NOT NULL DEFAULT 'ts',
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "forecasts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "metric_alerts" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "metricKey" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'org',
    "clientOrgId" TEXT,
    "condition" TEXT NOT NULL,
    "threshold" DOUBLE PRECISION NOT NULL,
    "windowDays" INTEGER NOT NULL DEFAULT 7,
    "roles" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "userIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "builtIn" BOOLEAN NOT NULL DEFAULT false,
    "lastValue" DOUBLE PRECISION,
    "lastCheckedAt" TIMESTAMP(3),
    "lastFiredAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "metric_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "metric_alert_events" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "alertId" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "baseline" DOUBLE PRECISION,
    "message" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "metric_alert_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scheduled_reports" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "dashboardId" TEXT,
    "metricKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "cadence" TEXT NOT NULL,
    "dayOfWeek" INTEGER,
    "dayOfMonth" INTEGER,
    "hourIst" INTEGER NOT NULL DEFAULT 9,
    "recipients" TEXT[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "nextRunAt" TIMESTAMP(3) NOT NULL,
    "lastSentAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scheduled_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "goals" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "ownerId" TEXT,
    "departmentId" TEXT,
    "metricKey" TEXT,
    "direction" TEXT NOT NULL DEFAULT 'higher',
    "startValue" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "target" DOUBLE PRECISION NOT NULL,
    "unit" TEXT NOT NULL DEFAULT '',
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "archivedAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "goals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "goal_check_ins" (
    "id" TEXT NOT NULL,
    "goalId" TEXT NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "note" TEXT,
    "byId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "goal_check_ins_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_ops" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "clientOpId" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "op" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL,
    "result" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sync_ops_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "push_tokens" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "push_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "user_sessions_userId_revokedAt_idx" ON "user_sessions"("userId", "revokedAt");

-- CreateIndex
CREATE UNIQUE INDEX "passkeys_credentialId_key" ON "passkeys"("credentialId");

-- CreateIndex
CREATE INDEX "passkeys_userId_idx" ON "passkeys"("userId");

-- CreateIndex
CREATE INDEX "consents_orgId_subjectType_subjectId_idx" ON "consents"("orgId", "subjectType", "subjectId");

-- CreateIndex
CREATE INDEX "consents_orgId_email_idx" ON "consents"("orgId", "email");

-- CreateIndex
CREATE INDEX "data_requests_orgId_status_dueAt_idx" ON "data_requests"("orgId", "status", "dueAt");

-- CreateIndex
CREATE UNIQUE INDEX "retention_rules_orgId_recordType_key" ON "retention_rules"("orgId", "recordType");

-- CreateIndex
CREATE INDEX "forecasts_orgId_kind_idx" ON "forecasts"("orgId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "forecasts_orgId_kind_subjectType_subjectId_period_key" ON "forecasts"("orgId", "kind", "subjectType", "subjectId", "period");

-- CreateIndex
CREATE INDEX "metric_alerts_orgId_active_idx" ON "metric_alerts"("orgId", "active");

-- CreateIndex
CREATE INDEX "metric_alert_events_alertId_createdAt_idx" ON "metric_alert_events"("alertId", "createdAt");

-- CreateIndex
CREATE INDEX "metric_alert_events_orgId_createdAt_idx" ON "metric_alert_events"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX "scheduled_reports_active_nextRunAt_idx" ON "scheduled_reports"("active", "nextRunAt");

-- CreateIndex
CREATE INDEX "goals_orgId_endDate_idx" ON "goals"("orgId", "endDate");

-- CreateIndex
CREATE INDEX "goal_check_ins_goalId_createdAt_idx" ON "goal_check_ins"("goalId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "sync_ops_userId_clientOpId_key" ON "sync_ops"("userId", "clientOpId");

-- CreateIndex
CREATE UNIQUE INDEX "push_tokens_token_key" ON "push_tokens"("token");

-- CreateIndex
CREATE INDEX "push_tokens_userId_idx" ON "push_tokens"("userId");

-- CreateIndex
CREATE INDEX "audit_events_orgId_seq_idx" ON "audit_events"("orgId", "seq");

-- AddForeignKey
ALTER TABLE "goal_check_ins" ADD CONSTRAINT "goal_check_ins_goalId_fkey" FOREIGN KEY ("goalId") REFERENCES "goals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "email_outbox" ADD COLUMN "attachments" JSONB;

-- AlterTable
ALTER TABLE "notifications" ADD COLUMN "snoozedUntil" TIMESTAMP(3),
ADD COLUMN "ref" TEXT;

-- v20: put the new "Forecast & risks" section on existing Command Centre dashboards, right after the AI digest.
UPDATE "dashboards" d SET "layout" = (
  SELECT jsonb_agg(x.e ORDER BY x.ord)
  FROM (
    SELECT t.e, t.ord * 2 AS ord FROM jsonb_array_elements(d."layout"::jsonb) WITH ORDINALITY AS t(e, ord)
    UNION ALL
    SELECT '{"id":"command_centre.forecast_risks","type":"section","size":"full","dashboard":"command_centre","section":"forecast_risks"}'::jsonb,
      COALESCE((SELECT t2.ord * 2 + 1 FROM jsonb_array_elements(d."layout"::jsonb) WITH ORDINALITY AS t2(e, ord) WHERE t2.e->>'section' = 'ai_digest' LIMIT 1), 1)
  ) x
)
WHERE d."builtin" = 'command_centre' AND jsonb_typeof(d."layout"::jsonb) = 'array' AND NOT (d."layout"::jsonb @> '[{"section":"forecast_risks"}]'::jsonb);
