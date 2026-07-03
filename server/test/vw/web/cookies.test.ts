import { describe, it, expect } from "vitest";
import { newJars, jarFor, mergeSetCookie, cookieHeader } from "../../../src/vw/web/cookies.js";

describe("per-domain cookie jars", () => {
  it("routes myvolkswagen.net and vwgroup.io to separate jars", () => {
    const jars = newJars();
    expect(jarFor(jars, "www.myvolkswagen.net")).toBe(jars.myvw);
    expect(jarFor(jars, "identity.vwgroup.io")).toBe(jars.vwgroup);
  });

  it("merges Set-Cookie values and serializes a header", () => {
    const jar = new Map<string, string>();
    const h = new Headers();
    h.append("set-cookie", "SESSION=abc; Path=/; HttpOnly");
    h.append("set-cookie", "csrf_token=xyz; Path=/");
    mergeSetCookie(jar, h);
    expect(cookieHeader(jar)).toBe("SESSION=abc; csrf_token=xyz");
  });

  it("treats Max-Age=0 as deletion", () => {
    const jar = new Map<string, string>([["dead", "1"]]);
    const h = new Headers();
    h.append("set-cookie", "dead=; Max-Age=0; Path=/");
    mergeSetCookie(jar, h);
    expect(jar.has("dead")).toBe(false);
  });
});
