-- Somewhere to send a notification that is not an inbox.
--
-- Until now a notification reached people two ways: a row in Notification, read
-- by the bell inside the app, and an email. Both need the person to come and
-- look. This is the third channel — the one that reaches a phone lying on a
-- desk, which is the point of the whole exercise for a meeting reminder.
--
-- Timestamped after 20260910120000_recurrence_editing deliberately. Naming this
-- by when the work started would have inserted it behind a migration already
-- applied in production, so the applied order and the recorded order would
-- disagree for good. Nothing here touches the same tables, so the order carries
-- no meaning beyond being honest.

-- A row is a browser on a device, not a person. The same user on a phone and a
-- laptop is two rows; clearing site data and subscribing again is a third while
-- the first is still on file and still being sent to.
CREATE TABLE "PushSubscription" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PushSubscription_pkey" PRIMARY KEY ("id")
);

-- The push service issues the endpoint, and it is the only thing identifying
-- the same subscription twice. Unique so re-subscribing a browser updates its
-- row instead of adding one, which would deliver the same alert to the same
-- device two or three times over.
CREATE UNIQUE INDEX "PushSubscription_endpoint_key" ON "PushSubscription"("endpoint");

-- Every send starts by asking for one user's endpoints.
CREATE INDEX "PushSubscription_userId_idx" ON "PushSubscription"("userId");

-- Cascade: a deleted account must not leave a live endpoint behind that the
-- server would go on encrypting messages to.
ALTER TABLE "PushSubscription" ADD CONSTRAINT "PushSubscription_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Defaults false where the other channel switches default true. Push is the
-- only one that also needs the browser's own permission, so defaulting it on
-- would record a preference nobody stated and no device had granted.
ALTER TABLE "UserPreferences" ADD COLUMN "pushNotifications" BOOLEAN NOT NULL DEFAULT false;
