ALTER TABLE knowledge_sources
  ADD COLUMN IF NOT EXISTS license_ref text,
  ADD COLUMN IF NOT EXISTS license_note text;

ALTER TABLE knowledge_sources
  DROP CONSTRAINT IF EXISTS knowledge_sources_published_license_check;

ALTER TABLE knowledge_sources
  ADD CONSTRAINT knowledge_sources_published_license_check CHECK (
    status <> 'published'
    OR (
      content_ref IS NOT NULL
      AND license_status IN ('public', 'licensed', 'internal_authorized')
      AND (license_status = 'internal_authorized' OR license_ref IS NOT NULL)
    )
  );

COMMENT ON COLUMN knowledge_sources.license_ref IS
  'Exact public license URL or authorized license reference used for this source version.';
COMMENT ON COLUMN knowledge_sources.license_note IS
  'Short source-specific rights note; citation_only sources remain outside full-text indexing.';
