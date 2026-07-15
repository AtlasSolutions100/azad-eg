---
name: Procas encryption key rotation
description: How the Procas master encryption key is rotated without breaking stored credentials
---

Rotation rule: `PROCAS_ENC_KEY_OLD` is a decrypt-only fallback. To rotate, move the current key into `PROCAS_ENC_KEY_OLD`, set the new key in `PROCAS_ENC_KEY`, restart the API server; a startup routine (and lazy re-seal on read) re-encrypts the stored Procas credential under the new key. Remove the old key once re-sealed.

**Why:** GCM ciphertext sealed with the old key would fail to decrypt after a naive key swap, silently breaking connect/sync. Keeping the old key decrypt-only plus auto re-seal makes rotation zero-downtime.

**How to apply:** Any new credential stored via the shared crypto helpers gets the same behavior for free — encrypt always uses the current key; decrypt tries current key (both salts) then old key (both salts) and fails loudly with a rotation hint if nothing matches. Don't add per-credential key handling.
