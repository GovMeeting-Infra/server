-- Offline attendance capture.
--
-- Every column is nullable or defaulted, so on PostgreSQL 11+ this is a
-- catalogue-only change: no table rewrite, no exclusive lock held while rows
-- are copied, and safe to run against a live box during a working day.
--
-- Deliberately not a new CheckInMethod value. That enum answers how presence
-- was established (scanned, GPS-verified, vouched for by staff), which an
-- offline row still answers for itself; adding OFFLINE would have overwritten
-- that answer and quietly changed every grouping that already reads it.
ALTER TABLE "Attendance" ADD COLUMN "capturedOffline" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Attendance" ADD COLUMN "capturedAt"      TIMESTAMP(3);
ALTER TABLE "Attendance" ADD COLUMN "syncedAt"        TIMESTAMP(3);
ALTER TABLE "Attendance" ADD COLUMN "capturedById"    TEXT;
-- Seconds, not milliseconds: a clock reset to 1970 is out by ~1.79e12 ms,
-- which overflows a 4-byte integer, and that device is precisely the one this
-- column exists to describe.
ALTER TABLE "Attendance" ADD COLUMN "clockSkewSeconds" INTEGER;

-- Partial: the column is false for almost every row, and the only question
-- anyone asks of it is "which of these were captured offline".
CREATE INDEX "Attendance_capturedOffline_idx"
  ON "Attendance" ("capturedOffline")
  WHERE "capturedOffline" = true;
