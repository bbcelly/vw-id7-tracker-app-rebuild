import path from "node:path";
import fs from "node:fs";
import { newJars, jarFor, mergeSetCookie, cookieHeader, type DomainJars } from "./cookies.js";

export const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const PORTAL = "https://www.myvolkswagen.net/cz/cs/myvolkswagen.html";
const IDP = "https://identity.vwgroup.io";
const LOGIN_INIT =
  "https://www.myvolkswagen.net/app/authproxy/login?fag=vw-phs,vwag-weconnect" +
  "&scope-vw-phs=profile,cars,vin&scope-vwag-weconnect=openid,mbb&prompt-vwag-weconnect=none" +
  `&redirectUrl=${encodeURIComponent(PORTAL)}&sessionTimeout=1800`;

export interface MyVwSession {
  cookies: Record<string, string>;
  csrfToken: string;
}

function sessionFile(): string {
  const dbPath = process.env.DB_PATH || path.join(process.cwd(), "data", "tracker.db");
  return path.join(path.dirname(dbPath), "myvw-session.json");
}

function extractState(html: string): string | null {
  return (
    html.match(/<input[^>]+name=["']state["'][^>]+value=["']([^"']+)["']/i) ??
    html.match(/<input[^>]+value=["']([^"']+)["'][^>]+name=["']state["']/i)
  )?.[1] ?? null;
}

export async function loginMyVw(
  username: string,
  password: string,
  fetchFn: typeof fetch = fetch
): Promise<MyVwSession> {
  const jars: DomainJars = newJars();

  async function step(url: string, init: RequestInit = {}): Promise<Response> {
    const host = new URL(url).host;
    const headers = new Headers(init.headers);
    headers.set("User-Agent", UA);
    headers.set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8");
    headers.set("Accept-Language", "cs-CZ,cs;q=0.9,en;q=0.8");
    const ck = cookieHeader(jarFor(jars, host));
    if (ck) headers.set("Cookie", ck);
    const resp = await fetchFn(url, { ...init, headers, redirect: "manual" });
    mergeSetCookie(jarFor(jars, host), resp.headers);
    return resp;
  }

  let url = LOGIN_INIT;
  let posted = false;
  for (let i = 0; i < 40; i++) {
    const resp = await step(url);
    const loc = resp.headers.get("location");
    if (resp.status >= 300 && resp.status < 400 && loc) {
      const next = new URL(loc, url).toString();
      if (/myvolkswagen\.net\/cz\/cs\/myvolkswagen\.html/.test(next)) break;
      url = next;
      continue;
    }
    if (resp.status === 200 && url.includes("/u/login") && !posted) {
      const html = await resp.text();
      const state = extractState(html) ?? new URL(url).searchParams.get("state");
      if (!state) throw new Error("Auth0 login form: no state field");
      const r2 = await step(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: IDP, Referer: url },
        body: new URLSearchParams({ state, username, password, action: "default" }).toString(),
      });
      posted = true;
      const loc2 = r2.headers.get("location");
      if (!loc2) throw new Error("login POST did not redirect (bad credentials?)");
      url = new URL(loc2, url).toString();
      continue;
    }
    throw new Error(`login stopped: status=${resp.status} url=${url.slice(0, 80)}`);
  }

  const csrf = jars.myvw.get("csrf_token");
  if (!csrf || !jars.myvw.get("SESSION")) {
    throw new Error("login finished without SESSION/csrf_token");
  }
  return { cookies: Object.fromEntries(jars.myvw.entries()), csrfToken: csrf };
}

export function saveSession(s: MyVwSession): void {
  try {
    fs.writeFileSync(sessionFile(), JSON.stringify(s));
  } catch {
    /* best-effort cache */
  }
}

export function loadSession(): MyVwSession | null {
  try {
    return JSON.parse(fs.readFileSync(sessionFile(), "utf8")) as MyVwSession;
  } catch {
    return null;
  }
}
