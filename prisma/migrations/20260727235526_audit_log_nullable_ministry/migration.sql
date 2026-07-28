-- Some auditable events belong to no ministry: a failed sign-in for an unknown
-- address, or an invitation accepted before the account is in use.
--
-- AuditService fell back to a literal 'SYSTEM' ministryId for those. No such
-- ministry exists, so every one of those inserts violated the foreign key and
-- was swallowed by the service's own try/catch — LOGIN_FAILED,
-- PASSWORD_CHANGED and INVITE_ACCEPTED had never been recorded once.

-- AlterTable
ALTER TABLE "AuditLog" ALTER COLUMN "ministryId" DROP NOT NULL;
