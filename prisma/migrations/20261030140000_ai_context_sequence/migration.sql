ALTER TABLE "ai_conversations" ADD COLUMN "context" TEXT;
ALTER TABLE "ai_messages" ADD COLUMN "sequence" BIGSERIAL;
CREATE UNIQUE INDEX "ai_messages_sequence_key" ON "ai_messages"("sequence");
