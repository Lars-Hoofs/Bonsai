-- Shared schema holds cross-tenant, NON-DATA objects only (currently the
-- pgvector extension). It is added to the tenant runtime search_path so vector
-- types/operators resolve, while `public` (control-plane tables) stays excluded
-- — isolation of tenant data remains by construction.
CREATE SCHEMA IF NOT EXISTS shared;
CREATE EXTENSION IF NOT EXISTS vector SCHEMA shared;
