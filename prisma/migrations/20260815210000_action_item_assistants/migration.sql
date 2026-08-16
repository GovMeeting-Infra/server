-- Someone helping with an action item, without being answerable for it.
--
-- A separate table rather than making ownership a list, because one person has
-- to stay accountable. An assistant may report progress and move the status;
-- the narrower permission is enforced in ActionItemsService, not here.
--
-- userId is required and references a real account: helping means signing in
-- to change something, so a helper with no account could be named but could
-- never help.

CREATE TABLE "ActionItemAssistant" (
    "id" TEXT NOT NULL,
    "actionItemId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "addedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActionItemAssistant_pkey" PRIMARY KEY ("id")
);

-- Asking the same person twice is the same fact, not a second one.
CREATE UNIQUE INDEX "ActionItemAssistant_actionItemId_userId_key"
    ON "ActionItemAssistant"("actionItemId", "userId");

-- "What am I helping with" is the other direction this is read from.
CREATE INDEX "ActionItemAssistant_userId_idx" ON "ActionItemAssistant"("userId");

ALTER TABLE "ActionItemAssistant" ADD CONSTRAINT "ActionItemAssistant_actionItemId_fkey"
    FOREIGN KEY ("actionItemId") REFERENCES "ActionItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ActionItemAssistant" ADD CONSTRAINT "ActionItemAssistant_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
