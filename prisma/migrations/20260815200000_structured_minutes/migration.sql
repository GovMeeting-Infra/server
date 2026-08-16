-- Minutes stop being prose.
--
-- The record was one long body plus a summary, which put decisions inside a
-- paragraph where they could not be counted, searched precisely or acted on.
-- It becomes three lists instead: decisions and next steps here, alongside the
-- action items that already existed.
--
-- Dropping body and summary destroys every existing minutes narrative. That is
-- deliberate and was decided with the product owner; take a backup of the
-- Minutes table before running this anywhere real.

CREATE TYPE "MinutePointType" AS ENUM ('DECISION', 'NEXT_STEP');

CREATE TABLE "MinutePoint" (
    "id" TEXT NOT NULL,
    "minutesId" TEXT NOT NULL,
    "type" "MinutePointType" NOT NULL,
    "text" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MinutePoint_pkey" PRIMARY KEY ("id")
);

-- Every read is "the points of one minutes record, of one kind, in order".
CREATE INDEX "MinutePoint_minutesId_type_order_idx" ON "MinutePoint"("minutesId", "type", "order");

ALTER TABLE "MinutePoint" ADD CONSTRAINT "MinutePoint_minutesId_fkey"
    FOREIGN KEY ("minutesId") REFERENCES "Minutes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Minutes" DROP COLUMN "body";
ALTER TABLE "Minutes" DROP COLUMN "summary";
