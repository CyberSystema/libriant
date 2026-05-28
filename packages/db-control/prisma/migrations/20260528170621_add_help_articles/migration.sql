-- Help center: articles authored as Markdown in /locales/<lang>/help/,
-- ingested into this table, and searched via Postgres FTS over the
-- title + body, with the right text-search config per locale.

CREATE TABLE "help_articles" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "tags" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 100,
    "bodyMarkdown" TEXT NOT NULL,
    "bodyHtml" TEXT NOT NULL,
    "sourceHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "help_articles_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "help_articles_locale_sortOrder_idx"
  ON "help_articles" ("locale", "sortOrder");

CREATE UNIQUE INDEX "help_articles_slug_locale_key"
  ON "help_articles" ("slug", "locale");

-- ---------------------------------------------------------------------------
-- Full-text search via a generated tsvector column.
--
-- We pick the text-search config per row from the article's locale: rows
-- in `el` get `simple` (Postgres has no Greek dictionary out of the box;
-- `simple` does word splitting without stemming, which combined with our
-- accent-fold below gives sane Greek-friendly results), rows in `en` get
-- the proper English dictionary. Adding a config for another locale only
-- requires extending the CASE branch.
--
-- We also unaccent the input before indexing so a librarian's query
-- "πατωντας" matches an article saying "πατώντας". `unaccent` isn't
-- IMMUTABLE by default, but we have it installed as an extension and
-- declare a wrapper that *is* IMMUTABLE so it can be used in a generated
-- column expression.
-- ---------------------------------------------------------------------------

-- `unaccent` is part of the contrib package; ensure it's available.
CREATE EXTENSION IF NOT EXISTS unaccent;

-- IMMUTABLE wrapper around unaccent's default dictionary. Required for
-- the generated column expression below.
CREATE OR REPLACE FUNCTION public.immutable_unaccent(text)
  RETURNS text
  LANGUAGE sql
  IMMUTABLE PARALLEL SAFE STRICT
AS $$
  SELECT unaccent('public.unaccent'::regdictionary, $1)
$$;

ALTER TABLE "help_articles"
  ADD COLUMN "search_tsv" tsvector
  GENERATED ALWAYS AS (
    setweight(
      to_tsvector(
        CASE WHEN "locale" = 'en' THEN 'english'::regconfig ELSE 'simple'::regconfig END,
        public.immutable_unaccent(coalesce("title", ''))
      ),
      'A'
    )
    ||
    setweight(
      to_tsvector(
        CASE WHEN "locale" = 'en' THEN 'english'::regconfig ELSE 'simple'::regconfig END,
        public.immutable_unaccent(coalesce("summary", ''))
      ),
      'B'
    )
    ||
    setweight(
      to_tsvector(
        CASE WHEN "locale" = 'en' THEN 'english'::regconfig ELSE 'simple'::regconfig END,
        public.immutable_unaccent(coalesce("bodyMarkdown", ''))
      ),
      'C'
    )
    ||
    setweight(
      to_tsvector(
        CASE WHEN "locale" = 'en' THEN 'english'::regconfig ELSE 'simple'::regconfig END,
        public.immutable_unaccent(coalesce("tags", ''))
      ),
      'B'
    )
  ) STORED;

CREATE INDEX "help_articles_search_gin"
  ON "help_articles" USING gin ("search_tsv");
