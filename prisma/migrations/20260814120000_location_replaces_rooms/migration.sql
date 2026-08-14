-- Location takes over from rooms.
--
-- Room booking is being withdrawn: an organizer now types where a meeting is
-- rather than picking from a list of rooms someone had to register first. This
-- carries the existing information across so no event loses its location.
--
-- Only fills venueName where it is empty. An event that names a room AND has a
-- venue already has the more specific answer typed by a person, and overwriting
-- that with the room's name would lose it.
--
-- Room.location is included because it is where the room actually is — "Room
-- 4" alone tells an attendee nothing, whereas "Room 4, Main Block" does.
UPDATE "Event" e
SET "venueName" = CASE
    WHEN r."location" IS NULL OR r."location" = '' THEN r."name"
    ELSE r."name" || ', ' || r."location"
  END
FROM "Room" r
WHERE e."roomId" = r."id"
  AND (e."venueName" IS NULL OR btrim(e."venueName") = '');

-- The Room and RoomBooking tables and Event.roomId are deliberately NOT
-- dropped here. Nothing reads them after this change, so they cost nothing to
-- keep, and dropping them would destroy every booking record irreversibly.
-- That is a separate, deliberate migration to run once the withdrawal has
-- proved itself.
