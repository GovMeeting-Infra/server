-- Who a guest is, and whether a meeting insists on a geofence.
--
-- The three guest columns are nullable rather than NOT NULL DEFAULT '': every
-- row written before now genuinely has no answer, and an empty string would
-- claim one was given. Required-ness belongs to the guest check-in form and its
-- DTO, which is the only path that collects them — an organizer recording a
-- walk-in at the desk is not asked, and a signed-in member of staff carries a
-- job title and ministry on their account already.
ALTER TABLE "Attendance" ADD COLUMN "guestTitle" TEXT;

ALTER TABLE "Attendance" ADD COLUMN "guestOrganisation" TEXT;

ALTER TABLE "Attendance" ADD COLUMN "guestPhone" TEXT;

-- Defaults to false, which is exactly how every existing event already
-- behaves: when the organizer's fix was too poor to anchor a fence, the code
-- was minted without one. Turning this on makes that case a refusal instead.
ALTER TABLE "Event" ADD COLUMN "requireGeofence" BOOLEAN NOT NULL DEFAULT false;
