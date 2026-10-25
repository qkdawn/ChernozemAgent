CREATE TABLE IF NOT EXISTS field_scouting_notes (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  field_id uuid NOT NULL REFERENCES fields(id),
  observed_at date NOT NULL,
  longitude double precision NOT NULL,
  latitude double precision NOT NULL,
  water_condition text NOT NULL CHECK (water_condition IN ('dry', 'normal', 'wet', 'standing_water', 'unknown')),
  leaf_color text NOT NULL CHECK (leaf_color IN ('normal', 'pale', 'dark_green', 'unknown')),
  disease_or_pest text NOT NULL CHECK (disease_or_pest IN ('none_seen', 'suspected', 'unknown')),
  note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS field_scouting_notes_field_date_idx
  ON field_scouting_notes (organization_id, field_id, observed_at DESC, created_at DESC);

COMMENT ON TABLE field_scouting_notes IS
  'Independent geolocated field observations. Notes are not analysis conclusions and only enter a task when explicitly selected.';
