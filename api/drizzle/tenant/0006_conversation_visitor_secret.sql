ALTER TABLE conversations ADD COLUMN visitor_secret text NOT NULL DEFAULT '';
ALTER TABLE conversations ALTER COLUMN visitor_secret DROP DEFAULT;
