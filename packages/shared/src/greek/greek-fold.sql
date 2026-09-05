-- libriant_fold_greek — the Postgres half of `foldGreek`.
--
-- This function must return, for every input, EXACTLY what
-- `foldGreek` in packages/shared/src/greek.ts returns. `pnpm
-- check:greek-folding` runs the whole fixture through both and fails on any
-- divergence; there is no tolerance and no "close enough".
--
-- WHY BOTH SIDES EXIST. The fold is applied in two places that can never see
-- each other: when a record is written (search_text is computed in Node) and
-- when an index expression or a generated column is evaluated (Postgres). If
-- they disagree by one code point, the row is indexed under a key the query
-- never produces, and the only symptom is a book that cannot be found.
--
-- TWO MEASURED DIVERGENCES THIS REPAIRS.
--
-- 1. SIGMA. Postgres and JavaScript disagree about lower('ΠΟΛΙΣ'):
--
--        psql> SELECT lower('ΠΟΛΙΣ');    -- ends U+03C3, no Final_Sigma rule
--        node> 'ΠΟΛΙΣ'.toLowerCase();    -- ends U+03C2, Final_Sigma applied
--
--    Neither is wrong; Unicode's conditional mapping is optional for a
--    locale-insensitive lower(). But it means the two runtimes have ALWAYS
--    produced different keys for capitalised Greek, silently. The translate()
--    below makes them agree: whichever sigma each runtime produces, both end
--    at U+03C3.
--
-- 2. Ύ AND Ώ, WHICH IS WHY lower() CARRIES AN EXPLICIT COLLATION. Sweeping
--    U+0370-U+03FF and U+1F00-U+1FFF and comparing Postgres lower() against
--    JavaScript toLowerCase() found exactly THREE disagreements, all caused by
--    the unassigned gap at U+038D shifting the platform's mapping table by one:
--
--      MEASURED, Postgres 16.15 on darwin, lower() with the database default:
--        U+038D (unassigned)  js -> U+038D    pg -> U+03CD
--        U+038E  Ύ            js -> U+03CD ύ  pg -> U+03CE ώ   WRONG
--        U+038F  Ώ            js -> U+03CE ώ  pg -> U+03CF Ϗ   WRONG
--
--    Ύ and Ώ are ordinary Greek letters — Ύδωρ, Ώρα — so under the default
--    collation every Greek word beginning with an accented capital upsilon or
--    omega was folded to the WRONG LETTER by the database and the right one by
--    the application. Unicode is unambiguous here (U+038E -> U+03CD,
--    U+038F -> U+03CE) and JavaScript is correct.
--
--    `COLLATE "und-x-icu"` fixes all three, exactly matching JavaScript. It is
--    the locale-neutral ICU root collation, deliberately NOT "el-GR-x-icu"
--    (which would be an equally correct answer here but invites someone to
--    "improve" it to a Turkish locale one day, where I lowercases to ı and
--    every Latin heading silently changes). Pinning the collation also removes
--    the platform from the equation: libc case tables differ between macOS and
--    glibc, ICU's do not.
--
-- IMMUTABLE is required, not decorative: without it this cannot appear in an
-- index expression or a generated column, which is the only reason it exists.
-- It is safe because it depends on nothing but its argument — note that
-- lower() here is the locale-INSENSITIVE one-argument form, and normalize()
-- is IMMUTABLE by definition.
--
-- normalize() is called as pg_catalog.normalize(x, 'NFD') and not with the
-- bare NFD keyword: the keyword spelling is parser sugar that only binds to
-- the UNqualified name, so `pg_catalog.normalize(x, NFD)` fails with
-- 'column "nfd" does not exist'. The two-text-argument form is the same
-- pg_catalog."normalize"(text,text) and is verified equal to the keyword
-- form, so the qualification rule survives intact.
--
-- Every function call is schema-qualified. This repository has already shipped
-- 20260825200000_qualify_immutable_unaccent to repair exactly this class of
-- bug, and lost a control-plane restore to an unqualified gen_random_uuid.

CREATE OR REPLACE FUNCTION libriant_fold_greek(input text)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $function$
  SELECT pg_catalog.btrim(
           pg_catalog.regexp_replace(
             pg_catalog.translate(
               pg_catalog.regexp_replace(
                 -- NFD splits every precomposed accent into base + combining
                 -- mark; the class below then removes the marks. U+0345
                 -- (combining ypogegrammeni, the polytonic iota subscript) is
                 -- 0x345 and therefore inside 0x300-0x36F, so `ᾳ` folds to `α`
                 -- with no special case -- the same property greek.ts relies on.
                 pg_catalog.normalize(pg_catalog.lower(input COLLATE "und-x-icu"), 'NFD'),
                 '[̀-ͯ]', '', 'g'
               ),
               -- Greek letters with more than one written form. Must stay in
               -- lock-step with VARIANT_FROM / VARIANT_TO in greek.ts.
               --   ς final sigma, ϲ lunate sigma, ϐ beta, ϑ theta, ϕ phi,
               --   ϖ pi, ϰ kappa, ϱ rho, ϵ lunate epsilon, µ micro sign,
               --   ϒ upsilon hook
               'ςϲϐϑϕϖϰϱϵµϒ',
               'σσβθφπκρεμυ'
             ),
             -- Collapse internal whitespace, then btrim the ends.
             '\s+', ' ', 'g'
           )
         );
$function$;

COMMENT ON FUNCTION libriant_fold_greek(text) IS
  'Greek/Latin search fold. Must match foldGreek() in @libriant/shared/greek exactly; '
  'enforced by pnpm check:greek-folding. See packages/shared/src/greek/greek-fold.sql.';
