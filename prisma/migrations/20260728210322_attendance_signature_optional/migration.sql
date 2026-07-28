-- AlterTable
ALTER TABLE "Attendance" ALTER COLUMN "signature" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Notification" ALTER COLUMN "expiresAt" SET DEFAULT now() + interval '30 days';
