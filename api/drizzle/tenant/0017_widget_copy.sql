-- Multi-language widget copy (#16): per-project widget UI copy (welcome
-- message, placeholders, button labels, etc.) defined per locale, with a
-- default/fallback locale. Mirrors the widget_configs surface: a separate
-- draft and published blob so editing never affects the live widget until
-- publish. Both draft and published store a JSON map of locale -> copy
-- object, e.g. { "en": { "welcome": "Hi!" }, "nl": { "welcome": "Hoi!" } }.
CREATE TABLE widget_copy (
  project_id uuid PRIMARY KEY,
  default_locale text NOT NULL DEFAULT 'en',
  draft jsonb NOT NULL DEFAULT '{}',
  published jsonb,
  published_version integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
