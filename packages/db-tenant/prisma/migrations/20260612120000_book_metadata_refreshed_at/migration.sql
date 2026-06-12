-- Track when a book's metadata was last refreshed/attempted against OpenLibrary.
-- Set on every attempt (found or not) by the `book-metadata-refresh` job so the
-- sweep progresses through the catalog instead of re-hitting the same rows.
ALTER TABLE "books" ADD COLUMN "metadataRefreshedAt" TIMESTAMP(3);

-- Supports the job's ordering (nulls first, then oldest) over the candidate set.
CREATE INDEX "books_metadataRefreshedAt_idx" ON "books"("metadataRefreshedAt");
