-- Drops room booking for good.
--
-- The previous migration (20260814120000_location_replaces_rooms) moved every
-- room name into the event's venueName, which is where a location lives now.
-- Nothing has read these tables since. Verified empty before running: 0 rooms,
-- 0 bookings, 0 events referencing a room.
--
-- Event.venueName is deliberately untouched — that is the location column, and
-- it is not part of this.
--
-- Order matters: the two foreign keys into Room have to go before Room does.
ALTER TABLE "Event" DROP COLUMN IF EXISTS "roomId";

DROP TABLE IF EXISTS "RoomBooking";

DROP TABLE IF EXISTS "Room";

-- BookingPurpose and BookingStatus existed only for RoomBooking.
DROP TYPE IF EXISTS "BookingPurpose";

DROP TYPE IF EXISTS "BookingStatus";
