CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS organizations (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO organizations (id, name)
VALUES ('00000000-0000-0000-0000-000000000001', '铁岭示范账户')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS authorized_areas (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  name text NOT NULL,
  boundary geometry(Polygon, 4326) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ST_IsValid(boundary))
);

CREATE INDEX IF NOT EXISTS authorized_areas_boundary_gix ON authorized_areas USING gist (boundary);
CREATE INDEX IF NOT EXISTS authorized_areas_organization_idx ON authorized_areas (organization_id);

INSERT INTO authorized_areas (id, organization_id, name, boundary)
VALUES (
  '00000000-0000-0000-0000-000000000002',
  '00000000-0000-0000-0000-000000000001',
  '铁岭示范授权范围',
  ST_SetSRID(ST_GeomFromText('POLYGON((120 39, 126 39, 126 44, 120 44, 120 39))'), 4326)
)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE fields ADD COLUMN IF NOT EXISTS organization_id uuid;
ALTER TABLE fields ADD COLUMN IF NOT EXISTS boundary_version integer NOT NULL DEFAULT 1;
UPDATE fields SET organization_id = '00000000-0000-0000-0000-000000000001' WHERE organization_id IS NULL;
ALTER TABLE fields ALTER COLUMN organization_id SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fields_organization_id_fkey') THEN
    ALTER TABLE fields ADD CONSTRAINT fields_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES organizations(id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS fields_organization_active_idx ON fields (organization_id, archived_at) WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS field_boundary_versions (
  id uuid PRIMARY KEY,
  field_id uuid NOT NULL REFERENCES fields(id),
  version integer NOT NULL,
  boundary geometry(Polygon, 4326) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (field_id, version),
  CHECK (ST_IsValid(boundary))
);

INSERT INTO field_boundary_versions (id, field_id, version, boundary, created_at)
SELECT gen_random_uuid(), id, boundary_version, boundary, created_at
FROM fields
ON CONFLICT (field_id, version) DO NOTHING;

CREATE TABLE IF NOT EXISTS field_seasons (
  id uuid PRIMARY KEY,
  field_id uuid NOT NULL REFERENCES fields(id),
  crop text NOT NULL CHECK (crop IN ('corn', 'soybean', 'rice')),
  season_year integer NOT NULL CHECK (season_year BETWEEN 2000 AND 2100),
  planting_date date,
  variety text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  UNIQUE (field_id, season_year)
);

INSERT INTO field_seasons (id, field_id, crop, season_year, planting_date, variety, created_at, updated_at)
SELECT gen_random_uuid(), id, crop, season_year, planting_date, variety, created_at, updated_at
FROM fields
ON CONFLICT (field_id, season_year) DO NOTHING;

CREATE INDEX IF NOT EXISTS field_seasons_active_idx ON field_seasons (field_id, season_year DESC) WHERE archived_at IS NULL;
