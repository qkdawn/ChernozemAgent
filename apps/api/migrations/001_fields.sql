CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE IF NOT EXISTS fields (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (char_length(trim(name)) BETWEEN 1 AND 80),
  crop text NOT NULL CHECK (crop IN ('corn', 'soybean', 'rice')),
  season_year integer NOT NULL CHECK (season_year BETWEEN 2000 AND 2100),
  planting_date date,
  variety text,
  boundary geometry(Polygon, 4326) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  CHECK (ST_IsValid(boundary)),
  CHECK (ST_Area(boundary::geography) BETWEEN 100 AND 200000000)
);

CREATE INDEX IF NOT EXISTS fields_boundary_gix ON fields USING gist (boundary);
CREATE INDEX IF NOT EXISTS fields_active_idx ON fields (archived_at) WHERE archived_at IS NULL;
