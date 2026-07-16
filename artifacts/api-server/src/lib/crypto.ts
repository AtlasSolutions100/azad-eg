import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

// Symmetric encryption for credentials stored at rest (e.g. the Procas API
// key). The master key material comes only from a managed secret injected at
// runtime (a dedicated PROCAS_ENC_KEY if provisioned, otherwise the existing
// SESSION_SECRET) — never from the database and never from source-controlled
// config — so a database leak does not expose the credential.
//
// KEY ROTATION
// To rotate the master key safely (best practice, or after a suspected leak):
//   1. Set PROCAS_ENC_KEY_OLD to the current value of PROCAS_ENC_KEY (or of
//      SESSION_SECRET if no dedicated key was ever provisioned).
//   2. Set PROCAS_ENC_KEY to the new secret value.
//   3. Restart the server. On boot (and on any read) stored ciphertext that
//      was sealed under the old key is transparently decrypted with
//      PROCAS_ENC_KEY_OLD and re-encrypted under the new key.
//   4. Once rotation is confirmed (connect/sync work, the stored value is
//      re-sealed), remove PROCAS_ENC_KEY_OLD.
// PROCAS_ENC_KEY_OLD is decrypt-only: new ciphertext is always sealed with
// the current key.
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // GCM standard nonce length
const ENC_PREFIX = "enc:v1:";

// Domain-separation salt for the derived key.
const KEY_SALT = "procas-connection-v1";

// scrypt is deliberately slow; cache derived keys per (secret, salt) pair so
// repeated encrypt/decrypt calls (and rotation fallbacks) stay cheap.
const keyCache = new Map<string, Buffer>();

function deriveKey(secret: string, salt: string): Buffer {
  const cacheId = `${salt}\u0000${secret}`;
  const cached = keyCache.get(cacheId);
  if (cached) return cached;
  const key = scryptSync(secret, salt, 32);
  keyCache.set(cacheId, key);
  return key;
}

// Resolve the secret that seeds the encryption key. A dedicated PROCAS_ENC_KEY
// is preferred for isolation; we fall back to SESSION_SECRET so the feature
// works without extra provisioning. Either way the value is a managed secret,
// not a committed env var.
function resolveSecret(): string {
  const dedicated = process.env.PROCAS_ENC_KEY;
  if (dedicated && dedicated.length > 0) return dedicated;
  const fallback = process.env.SESSION_SECRET;
  if (fallback && fallback.length > 0) return fallback;
  throw new Error(
    "No encryption secret available. Set PROCAS_ENC_KEY (or SESSION_SECRET) to protect stored credentials.",
  );
}

// Previous master key kept around during a rotation, for decryption only.
function resolveOldSecret(): string | null {
  const old = process.env.PROCAS_ENC_KEY_OLD;
  return old && old.length > 0 ? old : null;
}

function currentKey(): Buffer {
  return deriveKey(resolveSecret(), KEY_SALT);
}

// Every key that may have sealed existing ciphertext, in preference order:
// the current secret, then the rotation-era old secret.
function decryptionKeys(): Buffer[] {
  const secret = resolveSecret();
  const keys = [deriveKey(secret, KEY_SALT)];
  const oldSecret = resolveOldSecret();
  if (oldSecret && oldSecret !== secret) {
    keys.push(deriveKey(oldSecret, KEY_SALT));
  }
  return keys;
}

function decryptWith(key: Buffer, iv: Buffer, tag: Buffer, data: Buffer): string {
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

function parseCiphertext(value: string): { iv: Buffer; tag: Buffer; data: Buffer } {
  const body = value.slice(ENC_PREFIX.length);
  const [ivB64, tagB64, dataB64] = body.split(":");
  if (!ivB64 || !tagB64 || !dataB64) {
    throw new Error("Stored credential is malformed and cannot be decrypted.");
  }
  return {
    iv: Buffer.from(ivB64, "base64"),
    tag: Buffer.from(tagB64, "base64"),
    data: Buffer.from(dataB64, "base64"),
  };
}

// True when the value was produced by encryptSecret (vs. legacy plaintext).
export function isEncrypted(value: string): boolean {
  return value.startsWith(ENC_PREFIX);
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, currentKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENC_PREFIX}${iv.toString("base64")}:${tag.toString("base64")}:${encrypted.toString("base64")}`;
}

export function decryptSecret(value: string): string {
  // Tolerate legacy plaintext rows written before encryption was introduced.
  if (!isEncrypted(value)) return value;
  const { iv, tag, data } = parseCiphertext(value);
  let lastError: unknown;
  for (const key of decryptionKeys()) {
    try {
      return decryptWith(key, iv, tag, data);
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(
    "Stored credential could not be decrypted with any available key. " +
      "If the master key was rotated, set PROCAS_ENC_KEY_OLD to the previous key so the value can be re-encrypted, " +
      "or reconnect Procas to store fresh credentials.",
    { cause: lastError },
  );
}

// True when the value is ciphertext sealed under the *current* key. False for
// plaintext or ciphertext sealed under a rotated-out key — both should be re-sealed
// by re-encrypting the decrypted value with encryptSecret.
export function isSealedWithCurrentKey(value: string): boolean {
  if (!isEncrypted(value)) return false;
  let parsed: { iv: Buffer; tag: Buffer; data: Buffer };
  try {
    parsed = parseCiphertext(value);
  } catch {
    return false;
  }
  try {
    decryptWith(currentKey(), parsed.iv, parsed.tag, parsed.data);
    return true;
  } catch {
    return false;
  }
}
