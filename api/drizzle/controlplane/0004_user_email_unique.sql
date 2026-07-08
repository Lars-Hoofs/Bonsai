-- Email must be unique across users: combined with the verifier's
-- email_verified requirement, this closes the invite-by-email / email-swap
-- account-takeover vector (a second identity cannot claim an existing email).
ALTER TABLE users ADD CONSTRAINT users_email_unique UNIQUE (email);
