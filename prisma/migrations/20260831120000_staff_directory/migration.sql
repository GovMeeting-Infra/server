-- A ministry's staff roster, kept apart from the accounts table.
--
-- Every address in this platform is typed by hand today, and in the places
-- that matter most a typo is not a bounced email — it is a second person.
-- Attendance is unique on (eventId, guestEmail) and an invitee's
-- externalEmail is the only thing tying them to their RSVP, so
-- "abdul.mansary@" and "abdul.mansaray@" are two different attendees of the
-- same meeting, both looking correct in the register.
--
-- The obvious fix is to let people pick a colleague from a list. The obvious
-- mistake is to load that list into "User". A User row is a login identity:
-- it can sign in, it counts toward the ministry, it appears in the colleague
-- directory and it can be sent an invitation. Importing a ministry's whole
-- staff export would create hundreds of accounts for people nobody has
-- decided to onboard yet.
--
-- So the roster lives here instead, with no password, no session and no
-- relation to User. It is a staging list, not a mirror: the read endpoint
-- hides an entry once somebody holds the same address as a real account, so
-- the list shrinks as staff are onboarded rather than showing each of them
-- twice.
--
-- email is stored lowercased by the writer. It is the join key, and the case
-- drift already present in EventAttendee.externalEmail is exactly what this
-- table exists to stop being repeated.

CREATE TABLE "StaffDirectoryEntry" (
    "id" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT,
    "email" TEXT NOT NULL,
    "ministryId" TEXT NOT NULL,
    "source" TEXT,
    "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StaffDirectoryEntry_pkey" PRIMARY KEY ("id")
);

-- One row per person per ministry. The unique constraint is what makes the
-- import re-runnable: a second run of the same export updates rather than
-- duplicating.
CREATE UNIQUE INDEX "StaffDirectoryEntry_ministryId_email_key"
    ON "StaffDirectoryEntry"("ministryId", "email");

-- Every read is scoped to one ministry and then filtered by address, which is
-- the same shape as the unique index above; it serves the picker's lookups.
CREATE INDEX "StaffDirectoryEntry_ministryId_email_idx"
    ON "StaffDirectoryEntry"("ministryId", "email");

-- Cascade: a deleted ministry has no roster. These rows carry no history worth
-- orphaning, unlike audit logs, which is why those are nullable instead.
ALTER TABLE "StaffDirectoryEntry"
    ADD CONSTRAINT "StaffDirectoryEntry_ministryId_fkey"
    FOREIGN KEY ("ministryId") REFERENCES "Ministry"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
