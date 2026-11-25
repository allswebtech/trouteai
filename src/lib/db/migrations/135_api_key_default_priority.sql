-- The priority a key's requests wait with in a busy combo's queue when they carry no
-- x-trouteai-priority header: interactive, normal or background.
ALTER TABLE api_keys ADD COLUMN default_priority TEXT NOT NULL DEFAULT 'normal';
