-- Manual restore of an archived set of minutes.
--
-- Without this flag the nightly retention job would re-archive a restored
-- record the same night, because the record still satisfies its condition
-- (published, meeting older than six months). The exemption records that a
-- minister or super-admin deliberately took it back out of the archive.

-- AlterTable
ALTER TABLE "Minutes" ADD COLUMN     "archiveExempt" BOOLEAN NOT NULL DEFAULT false;
