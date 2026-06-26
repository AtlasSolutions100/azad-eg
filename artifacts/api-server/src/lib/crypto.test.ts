import { createCipheriv, randomBytes, scryptSync } from "node:crypto";
import { describe, expect, it } from "vitest";

const { encryptSecret, decryptSecret, isEncrypted } = await import("./crypto");

function resolveSecret(): string {
  const secret = process.env["PROCAS_ENC_KEY"] || process.env["SESSION_SECRET"];
  if (!secret) throw new Error("Test requires PROCAS_ENC_KEY or SESSION_SECRET");
  return secret;
}

// Reproduce the on-disk ciphertext format using an arbitrary derivation salt so
// we can simulate credentials written before the Procast -> Procas salt rename.
function encryptWithSalt(plaintext: string, salt: string): string {
  const key = scryptSync(resolveSecret(), salt, 32);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:v1:${iv.toString("base64")}:${tag.toString("base64")}:${encrypted.toString("base64")}`;
}

describe("crypto", () => {
  it("round-trips a secret with the current key", () => {
    const plaintext = "procas-api-key-12345";
    const ciphertext = encryptSecret(plaintext);
    expect(isEncrypted(ciphertext)).toBe(true);
    expect(ciphertext).not.toContain(plaintext);
    expect(decryptSecret(ciphertext)).toBe(plaintext);
  });

  it("decrypts ciphertext written with the legacy (pre-rename) salt", () => {
    const plaintext = "legacy-stored-api-key";
    const legacyCiphertext = encryptWithSalt(plaintext, "procast-connection-v1");
    expect(decryptSecret(legacyCiphertext)).toBe(plaintext);
  });

  it("passes through legacy plaintext values unchanged", () => {
    expect(decryptSecret("plain-text-value")).toBe("plain-text-value");
  });
});
