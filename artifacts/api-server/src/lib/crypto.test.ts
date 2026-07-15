import { createCipheriv, randomBytes, scryptSync } from "node:crypto";
import { describe, expect, it } from "vitest";

const { encryptSecret, decryptSecret, isEncrypted, isSealedWithCurrentKey } = await import("./crypto");

function resolveSecret(): string {
  const secret = process.env["PROCAS_ENC_KEY"] || process.env["SESSION_SECRET"];
  if (!secret) throw new Error("Test requires PROCAS_ENC_KEY or SESSION_SECRET");
  return secret;
}

// Reproduce the on-disk ciphertext format using an arbitrary derivation salt so
// we can simulate credentials written before the Procast -> Procas salt rename.
function encryptWithSalt(plaintext: string, salt: string, secret = resolveSecret()): string {
  const key = scryptSync(secret, salt, 32);
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

  describe("key rotation via PROCAS_ENC_KEY_OLD", () => {
    const OLD_SECRET = "old-master-key-material";

    function withEnv(overrides: Record<string, string | undefined>, fn: () => void) {
      const saved: Record<string, string | undefined> = {};
      for (const [k, v] of Object.entries(overrides)) {
        saved[k] = process.env[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      try {
        fn();
      } finally {
        for (const [k, v] of Object.entries(saved)) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
      }
    }

    it("decrypts ciphertext sealed under the old key when PROCAS_ENC_KEY_OLD is set", () => {
      const plaintext = "sealed-under-previous-key";
      const oldCiphertext = encryptWithSalt(plaintext, "procas-connection-v1", OLD_SECRET);
      withEnv({ PROCAS_ENC_KEY_OLD: OLD_SECRET }, () => {
        expect(decryptSecret(oldCiphertext)).toBe(plaintext);
        expect(isSealedWithCurrentKey(oldCiphertext)).toBe(false);
      });
    });

    it("also decrypts old-key ciphertext written with the legacy salt", () => {
      const plaintext = "old-key-legacy-salt";
      const oldCiphertext = encryptWithSalt(plaintext, "procast-connection-v1", OLD_SECRET);
      withEnv({ PROCAS_ENC_KEY_OLD: OLD_SECRET }, () => {
        expect(decryptSecret(oldCiphertext)).toBe(plaintext);
      });
    });

    it("fails loudly with a rotation hint when no available key can decrypt", () => {
      const orphaned = encryptWithSalt("unreachable", "procas-connection-v1", "some-forgotten-key");
      withEnv({ PROCAS_ENC_KEY_OLD: undefined }, () => {
        expect(() => decryptSecret(orphaned)).toThrow(/PROCAS_ENC_KEY_OLD/);
      });
    });

    it("re-sealing under the current key round-trips and is recognized as current", () => {
      const plaintext = "credential-to-reseal";
      const oldCiphertext = encryptWithSalt(plaintext, "procas-connection-v1", OLD_SECRET);
      withEnv({ PROCAS_ENC_KEY_OLD: OLD_SECRET }, () => {
        const resealed = encryptSecret(decryptSecret(oldCiphertext));
        expect(isSealedWithCurrentKey(resealed)).toBe(true);
        expect(decryptSecret(resealed)).toBe(plaintext);
      });
    });

    it("reports plaintext and legacy-salt values as not sealed with the current key", () => {
      expect(isSealedWithCurrentKey("plain-text-value")).toBe(false);
      const legacy = encryptWithSalt("legacy", "procast-connection-v1");
      expect(isSealedWithCurrentKey(legacy)).toBe(false);
      expect(isSealedWithCurrentKey(encryptSecret("fresh"))).toBe(true);
    });
  });
});
