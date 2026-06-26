---
name: Procas credential encryption
description: How the Procas API key is protected at rest and what must stay true.
---

The `procas_connection.api_key` column stores AES-256-GCM ciphertext, never plaintext.

**Why:** The key grants access to payroll/timesheet data; a DB leak must not expose it.

**How to apply:**
- Encryption/decryption lives in the persistence layer (`saveProcasConnection` encrypts, `getProcasConnection` decrypts) so route/sync callers keep working with the bare key in memory.
- The encryption key is derived (scrypt, fixed domain-separation salt) from a **managed secret** read at runtime — a dedicated `PROCAS_ENC_KEY` if provisioned, else the existing `SESSION_SECRET`. Never store the key in the DB or in source-controlled config (`.replit` `[userenv]`). `setEnvVars` writes shared env vars into `.replit`, which IS committed — do NOT use it for key material; that was caught and rejected in code review.
- Stored values are prefixed `enc:v1:`; `decryptSecret` passes through unprefixed values as legacy plaintext, so don't assume every stored value is ciphertext during migration.
- The domain-separation salt is `procas-connection-v1`. `decryptSecret` tries that key first, then falls back to the legacy salt `procast-connection-v1` (from before the Procast→Procas rename) so pre-rename ciphertext in any environment (incl. production) still decrypts with no forced reconnect. **Why:** renaming the salt without a fallback silently breaks decryption of already-stored keys. Keep the legacy fallback until you are certain no env holds pre-rename ciphertext.
- Rotating whichever secret seeds the key (not the salt) makes existing ciphertext undecryptable — reconnect Procas after a secret rotation.
- Never reintroduce plaintext storage or log the decrypted key.
