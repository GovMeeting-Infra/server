-- AlterTable
ALTER TABLE "ActionItem" ADD COLUMN     "ownerEmail" TEXT,
ADD COLUMN     "progressLink" TEXT,
ADD COLUMN     "progressNotes" TEXT;

-- AlterTable
ALTER TABLE "Notification" ALTER COLUMN "expiresAt" SET DEFAULT now() + interval '30 days';

-- CreateTable
CREATE TABLE "MinutesAccessToken" (
    "id" TEXT NOT NULL,
    "minutesId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MinutesAccessToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MinutesAccessToken_tokenHash_key" ON "MinutesAccessToken"("tokenHash");

-- CreateIndex
CREATE INDEX "MinutesAccessToken_minutesId_idx" ON "MinutesAccessToken"("minutesId");

-- CreateIndex
CREATE UNIQUE INDEX "MinutesAccessToken_minutesId_email_key" ON "MinutesAccessToken"("minutesId", "email");

-- AddForeignKey
ALTER TABLE "MinutesAccessToken" ADD CONSTRAINT "MinutesAccessToken_minutesId_fkey" FOREIGN KEY ("minutesId") REFERENCES "Minutes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
