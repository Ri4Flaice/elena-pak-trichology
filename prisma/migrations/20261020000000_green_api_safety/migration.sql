ALTER TYPE "CampaignStatus" ADD VALUE 'PAUSED';
ALTER TABLE "Campaign" ADD COLUMN "pauseReason" TEXT;
ALTER TABLE "Recipient" ADD COLUMN "deliveryStatus" TEXT;

CREATE TABLE "SenderState" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "intervalMs" INTEGER NOT NULL DEFAULT 60000,
  "dailyLimit" INTEGER NOT NULL DEFAULT 50,
  "seriesLimit" INTEGER NOT NULL DEFAULT 25,
  "seriesPauseMs" INTEGER NOT NULL DEFAULT 1800000,
  "timeZone" TEXT NOT NULL DEFAULT 'Asia/Qyzylorda',
  "startHour" INTEGER NOT NULL DEFAULT 10,
  "endHour" INTEGER NOT NULL DEFAULT 18,
  "nextAllowedAt" TIMESTAMP(3),
  "seriesCount" INTEGER NOT NULL DEFAULT 0,
  "activeCampaignId" TEXT,
  "pauseReason" TEXT,
  "stateInstance" TEXT,
  "stateTimestamp" BIGINT NOT NULL DEFAULT 0,
  "settingsAppliedAt" TIMESTAMP(3),
  "maintenanceUntil" TIMESTAMP(3),
  "maintenanceToken" TEXT,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE TABLE "ContactPreference" (
  "phone" TEXT NOT NULL PRIMARY KEY,
  "consentAt" TIMESTAMP(3),
  "consentSource" TEXT,
  "optedOutAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE TABLE "ChatIdentity" (
  "chatId" TEXT NOT NULL PRIMARY KEY,
  "phone" TEXT,
  "optedOutAt" TIMESTAMP(3)
);
CREATE TABLE "SendAttempt" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "instanceId" TEXT NOT NULL,
  "campaignId" TEXT NOT NULL,
  "recipientId" TEXT NOT NULL,
  "phone" TEXT NOT NULL,
  "quotaDay" TEXT NOT NULL,
  "outcome" TEXT NOT NULL DEFAULT 'SENDING',
  "idMessage" TEXT,
  "deliveryStatus" TEXT,
  "error" TEXT,
  "retryable" BOOLEAN NOT NULL DEFAULT false,
  "reviewNote" TEXT,
  "reservedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt" TIMESTAMP(3)
);
CREATE TABLE "GreenWebhookEvent" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "instanceId" TEXT NOT NULL,
  "idMessage" TEXT,
  "payload" JSONB NOT NULL,
  "applied" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "ChatIdentity_phone_idx" ON "ChatIdentity"("phone");
CREATE INDEX "SendAttempt_instanceId_quotaDay_idx" ON "SendAttempt"("instanceId", "quotaDay");
CREATE INDEX "SendAttempt_instanceId_outcome_idx" ON "SendAttempt"("instanceId", "outcome");
CREATE INDEX "SendAttempt_recipientId_reservedAt_idx" ON "SendAttempt"("recipientId", "reservedAt");
CREATE UNIQUE INDEX "SendAttempt_instanceId_idMessage_key" ON "SendAttempt"("instanceId", "idMessage");
CREATE INDEX "GreenWebhookEvent_instanceId_idMessage_applied_idx" ON "GreenWebhookEvent"("instanceId", "idMessage", "applied");
CREATE INDEX "Recipient_idMessage_idx" ON "Recipient"("idMessage");

-- The old schema had one env-configured instance and no actual send timestamp.
-- Bind its immutable history to that instance on first use; updatedAt is the
-- only available estimate. Do not fabricate delivery confirmations or consent.
INSERT INTO "SendAttempt" ("id", "instanceId", "campaignId", "recipientId", "phone", "quotaDay", "outcome", "idMessage", "error", "reservedAt", "finishedAt")
SELECT 'legacy-' || "id", '__legacy__', "campaignId", "id", "phone",
  to_char("updatedAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Qyzylorda', 'YYYY-MM-DD'),
  CASE WHEN "status" = 'SENDING' THEN 'UNKNOWN' ELSE "status"::text END,
  CASE WHEN row_number() OVER (PARTITION BY "idMessage" ORDER BY "id") = 1 THEN "idMessage" ELSE NULL END,
  COALESCE("error", 'Импорт истории: проверьте результат отправки вручную'), "updatedAt", "updatedAt"
FROM "Recipient" WHERE "status" IN ('SENDING', 'ACCEPTED', 'ERROR', 'UNKNOWN');

UPDATE "Recipient" SET "status" = 'UNKNOWN', "error" = 'Отправка прервана обновлением; проверьте результат вручную' WHERE "status" = 'SENDING';
UPDATE "Campaign" SET "status" = 'CREATED', "pauseReason" = 'После обновления продолжите вручную', "leaseToken" = NULL, "leaseUntil" = NULL WHERE "status" = 'RUNNING';
