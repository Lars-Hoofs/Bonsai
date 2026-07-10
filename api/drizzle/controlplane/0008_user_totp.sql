-- App-level TOTP 2FA (#49): control-plane table recording an optional,
-- enrollable second factor per dashboard user, additional to (and
-- independent of) the primary OIDC login. secret_encrypted holds the
-- AES-256-GCM ciphertext of the TOTP secret (see EncryptionService) — never
-- the raw base32 secret. `enabled` is false until the user proves possession
-- of the secret via a successful POST /v1/me/2fa/verify.
CREATE TABLE user_totp (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  secret_encrypted text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
