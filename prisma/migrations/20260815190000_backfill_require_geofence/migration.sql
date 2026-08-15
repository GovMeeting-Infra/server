-- Preserve today's behaviour before requireGeofence starts to mean something.
--
-- Until now the column only decided whether a check-in code could be minted
-- without a location fix. Whether attendees were *gated* depended solely on an
-- anchor existing, so an organizer who left the box unticked and generated a
-- code outdoors with a clean signal silently fenced their meeting.
--
-- The column now governs the gate, which is what its label always claimed.
-- Without this backfill every already-anchored meeting — nearly all of them
-- with the box unticked — would quietly stop checking location the moment this
-- deploys. Setting it where an anchor exists means every existing event carries
-- on behaving exactly as it does now, and the checkbox governs from here.
UPDATE "Event"
SET "requireGeofence" = true
WHERE "checkInAnchorLat" IS NOT NULL
  AND "checkInAnchorLng" IS NOT NULL
  AND "requireGeofence" = false;
