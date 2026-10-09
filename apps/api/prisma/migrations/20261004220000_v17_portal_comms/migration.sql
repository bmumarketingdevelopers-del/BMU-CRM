-- AlterTable
ALTER TABLE "notification_preferences" ADD COLUMN     "whatsapp" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "conversations" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "name" TEXT,
    "clientOrgId" TEXT,
    "userId" TEXT,
    "leadId" TEXT,
    "threadId" TEXT,
    "assigneeId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "unread" INTEGER NOT NULL DEFAULT 0,
    "lastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation_messages" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "externalId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'received',
    "error" TEXT,
    "authorId" TEXT,
    "messageId" TEXT,
    "aiDrafted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversation_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reply_templates" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'any',
    "body" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reply_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_settings" (
    "userId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "quietStart" TEXT,
    "quietEnd" TEXT,
    "digest" TEXT NOT NULL DEFAULT 'off',
    "digestHour" INTEGER NOT NULL DEFAULT 18,
    "lastDigestAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_settings_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "notification_deliveries" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "link" TEXT,
    "reason" TEXT NOT NULL,
    "sendAfter" TIMESTAMP(3) NOT NULL,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "collab_docs" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'brief',
    "clientOrgId" TEXT,
    "engagementId" TEXT,
    "leadId" TEXT,
    "clientVisible" BOOLEAN NOT NULL DEFAULT false,
    "state" BYTEA NOT NULL,
    "text" TEXT NOT NULL DEFAULT '',
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT NOT NULL,
    "updatedById" TEXT,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "collab_docs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "booking_pages" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "durationMin" INTEGER NOT NULL DEFAULT 30,
    "days" INTEGER[] DEFAULT ARRAY[1, 2, 3, 4, 5]::INTEGER[],
    "startTime" TEXT NOT NULL DEFAULT '10:00',
    "endTime" TEXT NOT NULL DEFAULT '18:00',
    "noticeHours" INTEGER NOT NULL DEFAULT 4,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "booking_pages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meetings" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "hostId" TEXT NOT NULL,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,
    "clientOrgId" TEXT,
    "leadId" TEXT,
    "bookedById" TEXT,
    "guestName" TEXT,
    "guestEmail" TEXT,
    "guestPhone" TEXT,
    "agenda" TEXT,
    "location" TEXT,
    "status" TEXT NOT NULL DEFAULT 'booked',
    "bookedVia" TEXT NOT NULL DEFAULT 'team',
    "notes" TEXT,
    "summary" TEXT,
    "actionItems" JSONB NOT NULL DEFAULT '[]',
    "cancelledAt" TIMESTAMP(3),
    "reminderAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "meetings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "conversations_orgId_status_lastMessageAt_idx" ON "conversations"("orgId", "status", "lastMessageAt");

-- CreateIndex
CREATE UNIQUE INDEX "conversations_orgId_channel_address_key" ON "conversations"("orgId", "channel", "address");

-- CreateIndex
CREATE INDEX "conversation_messages_conversationId_createdAt_idx" ON "conversation_messages"("conversationId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "conversation_messages_orgId_externalId_key" ON "conversation_messages"("orgId", "externalId");

-- CreateIndex
CREATE INDEX "reply_templates_orgId_idx" ON "reply_templates"("orgId");

-- CreateIndex
CREATE INDEX "notification_deliveries_sendAfter_sentAt_idx" ON "notification_deliveries"("sendAfter", "sentAt");

-- CreateIndex
CREATE INDEX "notification_deliveries_userId_sentAt_idx" ON "notification_deliveries"("userId", "sentAt");

-- CreateIndex
CREATE INDEX "collab_docs_orgId_updatedAt_idx" ON "collab_docs"("orgId", "updatedAt");

-- CreateIndex
CREATE INDEX "collab_docs_engagementId_idx" ON "collab_docs"("engagementId");

-- CreateIndex
CREATE INDEX "collab_docs_leadId_idx" ON "collab_docs"("leadId");

-- CreateIndex
CREATE UNIQUE INDEX "booking_pages_userId_key" ON "booking_pages"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "booking_pages_slug_key" ON "booking_pages"("slug");

-- CreateIndex
CREATE INDEX "meetings_hostId_startAt_idx" ON "meetings"("hostId", "startAt");

-- CreateIndex
CREATE INDEX "meetings_clientOrgId_startAt_idx" ON "meetings"("clientOrgId", "startAt");

-- AddForeignKey
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

