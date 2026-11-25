-- Why the answer did not come from the first choice (reason tokens, comma list) and how many
-- attempts came before it. Empty on a first-choice answer.
ALTER TABLE call_logs ADD COLUMN fallback TEXT DEFAULT NULL;
ALTER TABLE call_logs ADD COLUMN fallback_attempts INTEGER DEFAULT 0;
