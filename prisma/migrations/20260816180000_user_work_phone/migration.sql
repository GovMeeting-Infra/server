-- Give a staff attendance row the contact detail a guest row has always had.
--
-- The attendee table has rendered a Phone column since guest check-in shipped,
-- and for every civil servant who has ever checked in it has rendered an em
-- dash. Guests are asked for a number at the door; staff are not, because the
-- door is a two-field form on a phone in a corridor and it should stay that
-- way. So the number is recorded once on the account and copied onto the
-- attendance record at check-in.
--
-- Nullable with no default and no backfill: nobody has told us their number
-- yet, and an empty string would be indistinguishable from one they cleared
-- on purpose. Existing rows keep showing the em dash until the person fills
-- it in, which is the honest state.

ALTER TABLE "User" ADD COLUMN "phone" TEXT;
