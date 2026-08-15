-- Groundwork for telling people things.
--
-- Three unrelated-looking changes that all serve the same overhaul: a stamp so
-- an overdue notice fires once rather than every morning, a suppression list so
-- the one bulk email carries a real unsubscribe, and a nullable ministry so
-- super admins stop being silently dropped from every in-app notification.

ALTER TABLE "ActionItem" ADD COLUMN "overdueNotifiedAt" TIMESTAMP(3);

-- Keyed on the address, not an account: the weekly digest reaches people who
-- own action items without having accounts, and an opt-out they cannot
-- exercise is not an opt-out.
CREATE TABLE "EmailSuppression" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailSuppression_pkey" PRIMARY KEY ("id")
);

-- Unsubscribing twice is the same fact, and the digest reads this per address.
CREATE UNIQUE INDEX "EmailSuppression_email_kind_key" ON "EmailSuppression"("email", "kind");

-- Notification.ministryId was NOT NULL, and notifyMany drops any recipient
-- without a ministry — so a super admin, who belongs to none, received no
-- in-app notification of anything since the table was created.
ALTER TABLE "Notification" ALTER COLUMN "ministryId" DROP NOT NULL;
