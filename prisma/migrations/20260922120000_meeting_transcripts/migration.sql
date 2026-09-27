-- Meeting transcription. Audio is never stored anywhere; these tables hold the
-- text the speech-to-text provider returns, and the AI's suggested minutes.
-- Segment text is encrypted by the application before it is written.

CREATE TYPE "TranscriptStatus" AS ENUM ('RECORDING', 'COMPLETE', 'FAILED');
CREATE TYPE "AiDraftStatus" AS ENUM ('PENDING', 'READY', 'FAILED');

CREATE TABLE "Transcript" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "status" "TranscriptStatus" NOT NULL DEFAULT 'RECORDING',
    "provider" TEXT NOT NULL,
    "startedById" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "durationSec" INTEGER NOT NULL DEFAULT 0,
    "aiDraftStatus" "AiDraftStatus",
    "aiDraft" JSONB,
    "aiDraftError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Transcript_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TranscriptSegment" (
    "id" TEXT NOT NULL,
    "transcriptId" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "speaker" INTEGER,
    "text" TEXT NOT NULL,
    "startMs" INTEGER NOT NULL,
    "endMs" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TranscriptSegment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Transcript_eventId_key" ON "Transcript"("eventId");
CREATE INDEX "Transcript_status_idx" ON "Transcript"("status");
CREATE INDEX "TranscriptSegment_transcriptId_order_idx" ON "TranscriptSegment"("transcriptId", "order");

ALTER TABLE "Transcript" ADD CONSTRAINT "Transcript_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TranscriptSegment" ADD CONSTRAINT "TranscriptSegment_transcriptId_fkey" FOREIGN KEY ("transcriptId") REFERENCES "Transcript"("id") ON DELETE CASCADE ON UPDATE CASCADE;
