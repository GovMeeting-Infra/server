-- Organizer-anchored QR check-in.
--
-- Attendance.userId becomes nullable so guests (who have no account) can be
-- recorded. Previously the service wrote `userId || eventId` into a NOT NULL
-- foreign key, which threw on every anonymous check-in.
--
-- The (eventId, guestEmail) unique index coexists with the existing
-- (eventId, userId) one because Postgres treats NULLs as distinct: staff rows
-- have guestEmail NULL, guest rows have userId NULL, so neither collides.
--
-- Event gains the check-in anchor: the organizer's device location captured
-- once when they generate the QR code, reused unchanged by every rotating
-- token. Radius is a server constant, not a column.

-- AlterTable
ALTER TABLE "Attendance" ADD COLUMN     "guestEmail" TEXT,
ADD COLUMN     "guestName" TEXT,
ADD COLUMN     "isWalkIn" BOOLEAN NOT NULL DEFAULT false,
ALTER COLUMN "userId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Event" ADD COLUMN     "allowGuestCheckIn" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "checkInAnchorAccuracy" INTEGER,
ADD COLUMN     "checkInAnchorLat" DOUBLE PRECISION,
ADD COLUMN     "checkInAnchorLng" DOUBLE PRECISION,
ADD COLUMN     "checkInAnchorSetAt" TIMESTAMP(3),
ADD COLUMN     "checkInAnchorSetById" TEXT;

-- AlterTable
-- Pre-existing drift, unrelated to check-in: schema.prisma already declared this
-- default but the pushed database never had it. Folded in here because this is
-- the baseline migration and leaving it out would keep the two out of sync.
ALTER TABLE "Notification" ALTER COLUMN "expiresAt" SET DEFAULT now() + interval '30 days';

-- CreateIndex
CREATE UNIQUE INDEX "Attendance_eventId_guestEmail_key" ON "Attendance"("eventId", "guestEmail");
