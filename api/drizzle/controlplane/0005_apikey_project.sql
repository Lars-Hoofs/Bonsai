-- public_widget keys are scoped to a single project (the widget embeds one
-- project). Nullable: secret/server keys remain tenant-wide.
ALTER TABLE api_keys ADD COLUMN project_id uuid;
