-- Groundwork for changing a repeat rule after the activity has been scheduled.
--
-- Until now a rule could only be set at the moment of scheduling, so nothing
-- ever queried a series a second time and the gaps below did not show. Editing
-- one means repeatedly asking "which occurrences of this series have already
-- happened, and which are still to come" — a filter on seriesId partitioned by
-- startAt, against the largest table in the schema, with no index on seriesId
-- at all. A composite leading on seriesId also serves the plain lookups.
--
-- updatedAt tells a rule that has been changed from one that has never moved,
-- which is the whole point of the feature. Defaulted rather than backfilled so
-- the column is honest about rows that predate it — though as it happens there
-- are none: no recurring activity has ever been created in production.

CREATE INDEX "Event_seriesId_startAt_idx" ON "Event"("seriesId", "startAt");

ALTER TABLE "EventSeries" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
