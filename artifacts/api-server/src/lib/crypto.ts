import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

// Symmetric encryption for credentials stored at rest (e.g. the Procast API
// key). The master key material comes only from a managed secret injected at
// runtime (a dedicated PROCAST_ENC_KEY if provisioned, otherwise the existing
// SESSION_SECRET) — never from the database and never from source-controlled
// config — so a database leak does not expose the credential.
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // GCM standard nonce length
const ENC_PREFIX = "enc:v1:";

let cachedKey: Buffer | null = null;

// Resolve the secret that seeds the encryption key. A dedicated PROCAST_ENC_KEY
// is preferred for isolation; we fall back to SESSION_SECRET so the feature
// works without extra provisioning. Either way the value is a managed secret,
// not a committed env var. NOTE: rotating whichever secret is in use will make
// previously stored ciphertext undecryptable, so reconnect Procast afterwards.
function resolveSecret(): string {
  const dedicated = process.env.PROCAST_ENC_KEY;
  if (dedicated && dedicated.length > 0) return dedicated;
  const fallback = process.env.SESSION_SECRET;
  if (fallback && fallback.length > 0) return fallback;
  throw new Error(
    "No encryption secret available. Set PROCAST_ENC_KEY (or SESSION_SECRET) to protect stored credentials.",
  );
}

function getKey(): Buffer {
  if (cachedKey) return cachedKey;
  // Derive a stable 32-byte key from the configured secret (domain-separated by
  // a fixed salt) so any sufficiently random value works regardless of length.
  cachedKey = scryptSync(resolveSecret(), "procast-connection-v1", 32);
  return cachedKey;
}

// True when the value was produced by encryptSecret (vs. legacy plaintext).
export function isEncrypted(value: string): boolean {
  return value.startsWith(ENC_PREFIX);
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENC_PREFIX}${iv.toString("base64")}:${tag.toString("base64")}:${encrypted.toString("base64")}`;
}

export function decryptSecret(value: string): string {
  // Tolerate legacy plaintext rows written before encryption was introduced.
  if (!isEncrypted(value)) return value;
  const body = value.slice(ENC_PREFIX.length);
  const [ivB64, tagB64, dataB64] = body.split(":");
  if (!ivB64 || !tagB64 || !dataB64) {
    throw new Error("Stored credential is malformed and cannot be decrypted.");
  }
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const data = Buffer.from(dataB64, "base64");
  const decipher = createDecipheriv(ALGORITHM, getKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}
