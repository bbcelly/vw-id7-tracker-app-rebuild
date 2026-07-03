import { BROWSER_UA } from "./types.js";

export type CookieJar = Map<string, string>;

export function mergeSetCookie(jar: CookieJar, headers: Headers): void {
  const setCookie = headers.getSetCookie?.() ?? [];
  for (const c of setCookie) {
    const [pair] = c.split(";");
    const eq = pair.indexOf("=");
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}

export function cookieHeader(jar: CookieJar): string {
  return Array.from(jar.entries()).map(([k, v]) => `${k}=${v}`).join("; ");
}

/** One manual-redirect hop: browser UA, cookie carry, no auto-follow. */
export async function followRedirect(
  url: string,
  jar: CookieJar,
  init: RequestInit = {}
): Promise<{ status: number; location: string | null; body: string }> {
  const headers = new Headers(init.headers);
  headers.set("User-Agent", BROWSER_UA);
  headers.set(
    "Accept",
    "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
  );
  headers.set("Accept-Language", "en-US,en;q=0.9");
  if (jar.size) headers.set("Cookie", cookieHeader(jar));
  const resp = await fetch(url, { ...init, headers, redirect: "manual" });
  mergeSetCookie(jar, resp.headers);
  const location = resp.headers.get("location");
  const body = resp.status >= 300 && resp.status < 400 ? "" : await resp.text();
  return { status: resp.status, location, body };
}

export function resolveUrl(action: string, base: string): string {
  return new URL(action, base).toString();
}
