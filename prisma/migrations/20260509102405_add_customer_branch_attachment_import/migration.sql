-- CreateEnum
CREATE TYPE "PaymentTerms" AS ENUM ('CASH', 'CREDIT');

-- CreateEnum
CREATE TYPE "CustomerStatus" AS ENUM ('ACTIVE', 'CLOSED', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "DayOfWeek" AS ENUM ('SAT', 'SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI');

-- CreateEnum
CREATE TYPE "EditState" AS ENUM ('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'NEEDS_CORRECTION');

-- CreateEnum
CREATE TYPE "EditTarget" AS ENUM ('CUSTOMER', 'BRANCH');

-- CreateEnum
CREATE TYPE "AttachmentKind" AS ENUM ('SHOP', 'SIGNBOARD', 'CR', 'FREE');

-- CreateEnum
CREATE TYPE "ImportRowState" AS ENUM ('PENDING', 'CLEAN', 'QUARANTINED', 'PROMOTED', 'REJECTED');

-- CreateTable
CREATE TABLE "Customer" (
    "id" TEXT NOT NULL,
    "nmwcCode" TEXT NOT NULL,
    "legalName" TEXT NOT NULL,
    "paymentTerms" "PaymentTerms" NOT NULL DEFAULT 'CASH',
    "crNumber" TEXT,
    "crNumberNorm" TEXT,
    "channelId" TEXT,
    "subChannelId" TEXT,
    "primaryPhone" TEXT,
    "primaryPhoneNorm" TEXT,
    "altPhone" TEXT,
    "contactPerson" TEXT,
    "contactRole" TEXT,
    "status" "CustomerStatus" NOT NULL DEFAULT 'ACTIVE',
    "notes" TEXT,
    "completenessScore" INTEGER NOT NULL DEFAULT 0,
    "importBatchId" TEXT,
    "importRowId" TEXT,
    "crPhotoId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,
    "lastEditedById" TEXT,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Branch" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "branchCode" TEXT NOT NULL,
    "branchName" TEXT NOT NULL,
    "regionId" TEXT NOT NULL,
    "routeId" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "areaDescription" TEXT,
    "gpsLat" DOUBLE PRECISION,
    "gpsLng" DOUBLE PRECISION,
    "gpsAccuracy" DOUBLE PRECISION,
    "gpsCapturedAt" TIMESTAMP(3),
    "dayOfVisit" "DayOfWeek",
    "openingHours" TEXT,
    "deliveryWindow" TEXT,
    "coolersCount" INTEGER NOT NULL DEFAULT 0,
    "standsCount" INTEGER NOT NULL DEFAULT 0,
    "emptyBottlesCount" INTEGER NOT NULL DEFAULT 0,
    "shopPhotoId" TEXT,
    "signboardPhotoId" TEXT,
    "status" "CustomerStatus" NOT NULL DEFAULT 'ACTIVE',
    "completenessScore" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,
    "lastEditedById" TEXT,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Branch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerEdit" (
    "id" TEXT NOT NULL,
    "target" "EditTarget" NOT NULL,
    "customerId" TEXT,
    "branchId" TEXT,
    "state" "EditState" NOT NULL DEFAULT 'DRAFT',
    "submittedById" TEXT NOT NULL,
    "submittedAt" TIMESTAMP(3),
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "decisionReason" TEXT,
    "decisionCategory" TEXT,
    "fieldChanges" JSONB NOT NULL,
    "attachmentChanges" JSONB NOT NULL,
    "isReactivation" BOOLEAN NOT NULL DEFAULT false,
    "isWrongRoute" BOOLEAN NOT NULL DEFAULT false,
    "newRouteId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerEdit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Attachment" (
    "id" TEXT NOT NULL,
    "kind" "AttachmentKind" NOT NULL,
    "customerId" TEXT,
    "branchId" TEXT,
    "branchExtraId" TEXT,
    "r2Key" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "capturedById" TEXT NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL,
    "capturedLat" DOUBLE PRECISION,
    "capturedLng" DOUBLE PRECISION,
    "hash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Attachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportBatch" (
    "id" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'CUSTOMER',
    "uploadedById" TEXT NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL,
    "totalRows" INTEGER NOT NULL DEFAULT 0,
    "cleanRows" INTEGER NOT NULL DEFAULT 0,
    "quarantinedRows" INTEGER NOT NULL DEFAULT 0,
    "promotedRows" INTEGER NOT NULL DEFAULT 0,
    "rejectedRows" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ImportBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportRow" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "rowNumber" INTEGER NOT NULL,
    "raw" JSONB NOT NULL,
    "parsed" JSONB,
    "state" "ImportRowState" NOT NULL DEFAULT 'PENDING',
    "issues" JSONB,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ImportRow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExportJob" (
    "id" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "filters" JSONB NOT NULL,
    "status" TEXT NOT NULL,
    "r2Key" TEXT,
    "rowCount" INTEGER,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "errorMessage" TEXT,

    CONSTRAINT "ExportJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Customer_nmwcCode_key" ON "Customer"("nmwcCode");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_importRowId_key" ON "Customer"("importRowId");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_crPhotoId_key" ON "Customer"("crPhotoId");

-- CreateIndex
CREATE INDEX "Customer_status_deletedAt_idx" ON "Customer"("status", "deletedAt");

-- CreateIndex
CREATE INDEX "Customer_channelId_idx" ON "Customer"("channelId");

-- CreateIndex
CREATE INDEX "Customer_legalName_idx" ON "Customer"("legalName");

-- CreateIndex
CREATE INDEX "Customer_paymentTerms_idx" ON "Customer"("paymentTerms");

-- CreateIndex
CREATE UNIQUE INDEX "Branch_branchCode_key" ON "Branch"("branchCode");

-- CreateIndex
CREATE UNIQUE INDEX "Branch_shopPhotoId_key" ON "Branch"("shopPhotoId");

-- CreateIndex
CREATE UNIQUE INDEX "Branch_signboardPhotoId_key" ON "Branch"("signboardPhotoId");

-- CreateIndex
CREATE INDEX "Branch_routeId_status_deletedAt_idx" ON "Branch"("routeId", "status", "deletedAt");

-- CreateIndex
CREATE INDEX "Branch_customerId_idx" ON "Branch"("customerId");

-- CreateIndex
CREATE INDEX "Branch_regionId_idx" ON "Branch"("regionId");

-- CreateIndex
CREATE INDEX "CustomerEdit_state_submittedAt_idx" ON "CustomerEdit"("state", "submittedAt");

-- CreateIndex
CREATE INDEX "CustomerEdit_submittedById_state_idx" ON "CustomerEdit"("submittedById", "state");

-- CreateIndex
CREATE INDEX "CustomerEdit_customerId_state_idx" ON "CustomerEdit"("customerId", "state");

-- CreateIndex
CREATE INDEX "CustomerEdit_branchId_state_idx" ON "CustomerEdit"("branchId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "Attachment_r2Key_key" ON "Attachment"("r2Key");

-- CreateIndex
CREATE INDEX "Attachment_branchId_idx" ON "Attachment"("branchId");

-- CreateIndex
CREATE INDEX "Attachment_customerId_idx" ON "Attachment"("customerId");

-- CreateIndex
CREATE INDEX "Attachment_branchExtraId_idx" ON "Attachment"("branchExtraId");

-- CreateIndex
CREATE INDEX "ImportRow_batchId_state_idx" ON "ImportRow"("batchId", "state");

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_subChannelId_fkey" FOREIGN KEY ("subChannelId") REFERENCES "SubChannel"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_importRowId_fkey" FOREIGN KEY ("importRowId") REFERENCES "ImportRow"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_crPhotoId_fkey" FOREIGN KEY ("crPhotoId") REFERENCES "Attachment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Branch" ADD CONSTRAINT "Branch_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Branch" ADD CONSTRAINT "Branch_regionId_fkey" FOREIGN KEY ("regionId") REFERENCES "Region"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Branch" ADD CONSTRAINT "Branch_routeId_fkey" FOREIGN KEY ("routeId") REFERENCES "Route"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Branch" ADD CONSTRAINT "Branch_shopPhotoId_fkey" FOREIGN KEY ("shopPhotoId") REFERENCES "Attachment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Branch" ADD CONSTRAINT "Branch_signboardPhotoId_fkey" FOREIGN KEY ("signboardPhotoId") REFERENCES "Attachment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerEdit" ADD CONSTRAINT "CustomerEdit_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerEdit" ADD CONSTRAINT "CustomerEdit_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerEdit" ADD CONSTRAINT "CustomerEdit_submittedById_fkey" FOREIGN KEY ("submittedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerEdit" ADD CONSTRAINT "CustomerEdit_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_capturedById_fkey" FOREIGN KEY ("capturedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_branchExtraId_fkey" FOREIGN KEY ("branchExtraId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportBatch" ADD CONSTRAINT "ImportBatch_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportRow" ADD CONSTRAINT "ImportRow_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "ImportBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportRow" ADD CONSTRAINT "ImportRow_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExportJob" ADD CONSTRAINT "ExportJob_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
