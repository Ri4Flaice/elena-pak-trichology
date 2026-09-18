CREATE TYPE "CampaignStatus" AS ENUM ('CREATED', 'RUNNING', 'COMPLETED');
CREATE TYPE "RecipientStatus" AS ENUM ('PENDING', 'SENDING', 'ACCEPTED', 'ERROR', 'UNKNOWN', 'SKIPPED');
CREATE TABLE "Campaign" (
  "id" TEXT NOT NULL,
  "fileName" TEXT NOT NULL,
  "template" TEXT NOT NULL,
  "status" "CampaignStatus" NOT NULL DEFAULT 'CREATED',
  "leaseToken" TEXT,
  "leaseUntil" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Campaign_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "Recipient" (
  "id" TEXT NOT NULL,
  "campaignId" TEXT NOT NULL,
  "rowNumber" INTEGER NOT NULL,
  "firstName" TEXT NOT NULL,
  "lastName" TEXT NOT NULL,
  "phone" TEXT NOT NULL,
  "message" TEXT NOT NULL,
  "status" "RecipientStatus" NOT NULL DEFAULT 'PENDING',
  "error" TEXT,
  "idMessage" TEXT,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Recipient_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "LoginAttempt" (
  "key" TEXT NOT NULL,
  "count" INTEGER NOT NULL DEFAULT 0,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "LoginAttempt_pkey" PRIMARY KEY ("key")
);
CREATE INDEX "Campaign_createdAt_idx" ON "Campaign"("createdAt");
CREATE UNIQUE INDEX "Recipient_campaignId_rowNumber_key" ON "Recipient"("campaignId", "rowNumber");
CREATE INDEX "Recipient_campaignId_status_idx" ON "Recipient"("campaignId", "status");
ALTER TABLE "Recipient" ADD CONSTRAINT "Recipient_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
