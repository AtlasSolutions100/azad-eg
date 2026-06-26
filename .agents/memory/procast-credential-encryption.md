---
name: Procast credential encryption
description: How the Procast API key is protected at rest and what must stay true.
---

The `procast_connection.api_key` column stores AES-256-GCM ciphertext, never plaintext.

**Why:** The key grants access to payroll/timesheet data; a DB leak must not expose it.

**How to apply:**
- Encryption/decryption lives in the persistence layer (`saveProcastConnection` encrypts, `getProcastConnection` decrypts) so route/sync callers keep working with the bare key in memory.
- The encryption key is derived (scrypt, fixed domain-separation salt) from a **managed secret** read at runtime — a dedicated `PROCAST_ENC_KEY` if provisioned, else the existing `SESSION_SECRET`. Never store the key in the DB or in source-controlled config (`.replit` `[userenv]`). `setEnvVars` writes shared env vars into `.replit`, which IS committed — do NOT use it for key material; that was caught and rejected in code review.
- Stored values are prefixed `enc:v1:`; `decryptSecret` passes through unprefixed values as legacy plaintext, so don't assume every stored value is ciphertext during migration.
- Rotating whichever secret seeds the key makes existing ciphertext undecryptable — reconnect Procast after a rotation.
- Never reintroduce plaintext storage or log the decrypted key.
