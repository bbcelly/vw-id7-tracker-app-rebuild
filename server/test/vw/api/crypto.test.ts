import { describe, it, expect } from "vitest";
import {
  createPkcePair,
  qmauthNow,
  randomString,
  sha256Base64Url,
} from "../../../src/vw/api/crypto.js";

describe("PKCE + qmauth crypto (ported from original, live-verified constants)", () => {
  it("createPkcePair returns a verifier and S256 challenge", () => {
    const { codeVerifier, codeChallenge } = createPkcePair();
    expect(codeVerifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(codeChallenge).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(codeVerifier).not.toBe(codeChallenge);
  });

  it("createPkcePair produces a fresh pair each call", () => {
    expect(createPkcePair().codeVerifier).not.toBe(createPkcePair().codeVerifier);
  });

  it("sha256Base64Url is deterministic and base64url-safe", () => {
    const out = sha256Base64Url("hello");
    expect(out).toBe(sha256Base64Url("hello"));
    expect(out).not.toMatch(/[=+/]/);
  });

  it("randomString produces base64url chars", () => {
    expect(randomString(32)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("qmauth is stable within a 100 s window and rotates across windows", () => {
    const t = 1_750_000_000_000;
    expect(qmauthNow(t)).toBe(qmauthNow(t + 99_000 - (t % 100_000)));
    expect(qmauthNow(t)).not.toBe(qmauthNow(t + 100_000));
    expect(qmauthNow(t)).toMatch(/^v1:01da27b0:[0-9a-f]{64}$/);
  });
});
