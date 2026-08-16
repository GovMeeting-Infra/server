-- Drop a column nothing reads, and index the queries that actually run.
--
-- expiresAt carried a `now() + interval '30 days'` default and was read by no
-- code anywhere in the server. The real cleanup is cleanupOldNotifications,
-- which computes its own cutoff from createdAt and deletes only rows already
-- marked read. So the column described a retention policy the system does not
-- have, and would have been the obvious thing for someone to start trusting.
-- Unread notifications are kept indefinitely on purpose: they represent
-- something the person is still answerable for, and the list is paginated now
-- rather than capped, so an old one stays reachable instead of falling off.
--
-- The indexes: every read of this table filters by userId first, then either
-- by read (the badge count) or orders by createdAt (the list). The standalone
-- userId index was a prefix of both replacements, and the one on `read` was a
-- boolean across every row in the table — it could not narrow a result set
-- enough to earn its write cost on a table that grows with every meeting.

ALTER TABLE "Notification" DROP COLUMN "expiresAt";

DROP INDEX IF EXISTS "Notification_userId_idx";
DROP INDEX IF EXISTS "Notification_read_idx";
DROP INDEX IF EXISTS "Notification_createdAt_idx";

CREATE INDEX "Notification_userId_read_idx" ON "Notification"("userId", "read");
CREATE INDEX "Notification_userId_createdAt_idx" ON "Notification"("userId", "createdAt");
