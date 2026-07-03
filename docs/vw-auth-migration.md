# VW We Connect ID — Auth Migration Guide (2026-05)

How to fix an app that talks to the VW We Connect ID API after VW's
2026-05 backend changes. **The vehicle data API did not change — only login
and token acquisition did.** If your app separates "get a token" from "call the
API," you only touch the token part.

Verified live against the backend on 2026-05-30/31 with a We Connect ID account
(VW ID.7, password-only, no MFA), client_id `a24fba63-…@apps_vw-dilab_com`.

---

## 1. What broke

1. **Old login endpoints removed.** `https://emea.bff.cariad.digital/user-login/v1/authorize`
   and `/user-login/login/v1` now return **403** at VW's Azure WAF for everyone.
   Any client built on that BFF login wrapper (e.g. `npm-vwconnectidapi`) is dead.
2. **`identity.vwgroup.io` migrated to Auth0 New Universal Login.** The old
   `signin-service/v1/<clientId>/login/identifier` two-step HTML form is replaced
   by a single Auth0 page at `/u/login`. (Newer than most community fixes, which
   still target signin-service.)

## 2. What did NOT change — leave these alone

- `GET https://emea.bff.cariad.digital/vehicle/v1/vehicles`
- `GET .../vehicle/v1/vehicles/{vin}/selectivestatus?jobs=access,charging,climatisation,measurements`
- `GET .../vehicle/v1/vehicles/{vin}/parkingposition`
- Auth on data calls is still just `Authorization: Bearer <access_token>`.
  **No attestation headers** (`x-qmauth`, etc.) are needed for the data API.
- All JSON response shapes are unchanged — existing parsing/models keep working.

## 3. The new login → token sequence

```
1. GET https://identity.vwgroup.io/oidc/v1/authorize
     ?client_id=a24fba63-34b3-4d43-b181-942111e6bda8@apps_vw-dilab_com
     &redirect_uri=weconnect://authenticated
     &response_type=code id_token token        ← HYBRID flow — important
     &scope=openid profile badge cars dealers vin
     &state=<rand>&nonce=<rand>
     &code_challenge=<S256(verifier)>&code_challenge_method=S256
   → 302 to /u/login?state=<msgpack-state>

2. GET that /u/login URL  → 200 Auth0 HTML page.
   Scrape the hidden field:  <input ... name="state" value="<STATE>" ...>

3. POST to the SAME /u/login?state=… URL
     Content-Type: application/x-www-form-urlencoded
     body:  state=<STATE>&username=<email>&password=<pw>&action=default
     headers:
       User-Agent: <a BROWSER UA>          ← VW Android UA gets 401 here
       Origin:  https://identity.vwgroup.io
       Referer: <the /u/login URL>
     (carry cookies across every hop: did, auth0, idkit_p, idkit_clid, …)
   → 302  (on success).  A 200 here = login error page (bad password).

4. Follow the redirect chain manually (keep cookies, browser UA):
     /authorize/resume → /v2/api/flow-state/post-login → /v2/continue → /authorize/resume
   → 302 to:
     weconnect://authenticated#access_token=…&id_token=…&code=…
                               &expires_in=7200&state=…&token_type=Bearer

5. Read access_token + id_token straight from the URL FRAGMENT (after '#').
   Validate the returned state == the state you sent. Done.
```

The fragment `access_token` is a JWT (`iss=identity.vwgroup.io`, `aud=<client_id>`,
~2 h lifetime) and is **already accepted by the vehicle API**.

## 4. The trap: do NOT do the code exchange

The tempting next step — `POST .../auth/v1/idk/oidc/token` with
`grant_type=authorization_code` — is a dead end:
- It needs IDK attestation headers (`x-qmauth` HMAC, `x-assertion: 0`, …) or it 400s.
- Even done correctly it currently returns **502 "unexpected error from upstream"**
  (a live VW-side outage).

You don't need it. Because `response_type` is the **hybrid** `code id_token token`,
the usable tokens are already in the fragment (step 5) — the same path the official
web/app uses. Skip the exchange entirely and you avoid both the attestation
requirement and the 502.

## 5. Token refresh — the one change beyond "just login"

The fragment flow issues **no refresh token**. So replace any
`grant_type=refresh_token` renewal with a **re-run of the headless login** when the
~2 h access token expires or a data call returns 401. Server-side apps with stored
credentials: trivial and invisible. UI apps that only kept a refresh token: you must
retain credentials or re-prompt.

## 6. Reference implementation (dependency-free TypeScript, Node 18+/native fetch)

Drop-in: returns tokens; no persistence/framework coupling. Adapt the storage to
your app.

```ts
import { randomBytes, createHash } from "node:crypto";

const CLIENT_ID = "a24fba63-34b3-4d43-b181-942111e6bda8@apps_vw-dilab_com";
const REDIRECT_URI = "weconnect://authenticated";
const IDP = "https://identity.vwgroup.io";
const SCOPE = "openid profile badge cars dealers vin";
const BROWSER_UA =
  "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/124.0.0.0 Mobile Safari/537.36";

export interface VwTokens { accessToken: string; idToken: string; expiresAt: number }

const b64url = (b: Buffer) =>
  b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

type Jar = Map<string, string>;
function mergeCookies(jar: Jar, h: Headers) {
  for (const c of h.getSetCookie?.() ?? []) {
    const [pair] = c.split(";");
    const i = pair.indexOf("=");
    if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
}
const cookieHeader = (jar: Jar) =>
  Array.from(jar).map(([k, v]) => `${k}=${v}`).join("; ");

async function hop(url: string, jar: Jar, init: RequestInit = {}) {
  const h = new Headers(init.headers);
  h.set("User-Agent", BROWSER_UA);
  h.set("Accept", "text/html,application/xhtml+xml,*/*;q=0.8");
  if (jar.size) h.set("Cookie", cookieHeader(jar));
  const r = await fetch(url, { ...init, headers: h, redirect: "manual" });
  mergeCookies(jar, r.headers);
  const loc = r.headers.get("location");
  const body = r.status >= 300 && r.status < 400 ? "" : await r.text();
  return { status: r.status, loc, body };
}
const resolve = (a: string, b: string) => new URL(a, b).toString();

export async function vwLogin(username: string, password: string): Promise<VwTokens> {
  const jar: Jar = new Map();
  const verifier = b64url(randomBytes(64));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const state = b64url(randomBytes(16));

  const authorizeUrl = `${IDP}/oidc/v1/authorize?` + new URLSearchParams({
    client_id: CLIENT_ID, redirect_uri: REDIRECT_URI,
    response_type: "code id_token token", scope: SCOPE,
    state, nonce: b64url(randomBytes(16)),
    code_challenge: challenge, code_challenge_method: "S256",
  });

  // 1-2: reach the Auth0 /u/login page
  let cur = authorizeUrl, loginUrl = "", html = "";
  for (let i = 0; i < 8; i++) {
    const r = await hop(cur, jar);
    if (r.status >= 300 && r.status < 400 && r.loc) { cur = resolve(r.loc, cur); continue; }
    if (r.status === 200 && cur.includes("/u/login")) { loginUrl = cur; html = r.body; break; }
    throw new Error(`authorize: unexpected ${r.status} at ${cur}\n${r.body.slice(0, 800)}`);
  }
  if (!loginUrl) throw new Error("did not reach /u/login");

  // 3: POST credentials
  const sm =
    html.match(/<input[^>]+name=["']state["'][^>]+value=["']([^"']+)["']/i) ??
    html.match(/<input[^>]+value=["']([^"']+)["'][^>]+name=["']state["']/i);
  const formState = sm ? sm[1] : new URL(loginUrl).searchParams.get("state");
  if (!formState) throw new Error(`no state field in login page:\n${html.slice(0, 2000)}`);

  let r = await hop(loginUrl, jar, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: IDP, Referer: loginUrl,
    },
    body: new URLSearchParams({ state: formState, username, password, action: "default" }).toString(),
  });
  if (r.status === 200) throw new Error(`login rejected (bad password?):\n${r.body.slice(0, 600)}`);

  // 4: follow the resume chain to the weconnect:// callback
  cur = r.loc ? resolve(r.loc, loginUrl) : "";
  let finalUrl = "";
  for (let i = 0; i < 15 && cur; i++) {
    if (cur.startsWith(REDIRECT_URI)) { finalUrl = cur; break; }
    r = await hop(cur, jar);
    if (r.status >= 300 && r.status < 400 && r.loc) { cur = resolve(r.loc, cur); continue; }
    throw new Error(`resume chain stopped: ${r.status} at ${cur}`);
  }
  if (!finalUrl) throw new Error("never reached weconnect:// callback");

  // 5: read tokens from the fragment
  const frag = finalUrl.includes("#") ? finalUrl.split("#")[1] : "";
  const p = new URLSearchParams(frag);
  const accessToken = p.get("access_token");
  const idToken = p.get("id_token");
  const expiresIn = Number(p.get("expires_in") ?? "3600");
  if (p.get("state") && p.get("state") !== state) throw new Error("state mismatch");
  if (!accessToken || !idToken) throw new Error(`no tokens in fragment: ${frag.slice(0, 200)}`);

  return { accessToken, idToken, expiresAt: Date.now() + expiresIn * 1000 };
}

// --- using the token (data plane unchanged) ---
const BFF = "https://emea.bff.cariad.digital";

export async function vwApiGet<T>(path: string, tokens: VwTokens): Promise<T> {
  const r = await fetch(`${BFF}${path}`, {
    headers: {
      Authorization: `Bearer ${tokens.accessToken}`,
      Accept: "application/json",
      "User-Agent": "Volkswagen/3.61.0-android/14", // VW app UA is fine on the data API
    },
  });
  if (!r.ok) throw new Error(`VW GET ${path} failed: ${r.status} ${(await r.text()).slice(0, 300)}`);
  return r.json() as Promise<T>;
}

// Renewal = re-login (no refresh token exists). Re-run vwLogin() when
// Date.now() >= tokens.expiresAt - 60_000, or after any 401.
```

## 7. Migration checklist

| Area | Change |
|---|---|
| Vehicle data endpoints + response parsing | none |
| Bearer-token usage on data calls | none |
| Login routine | rewrite to the Auth0 `/u/login` flow above |
| Browser UA on the login POST | add (VW/Android UA → 401 on Auth0 pages) |
| Token source | read from callback fragment, not the code exchange |
| Token refresh | replace `refresh_token` grant with re-login |
| Any `x-qmauth` / attestation code | delete (only the unused code exchange needed it) |

## 8. Caveats

- This is the **VW We Connect ID** flow (client_id `a24fba63-…@apps_vw-dilab_com`).
  Audi / Škoda / Cupra share the VAG identity provider but use different
  client_ids / app package names — same shape, different constants.
- **No-MFA assumption.** With MFA the `/u/login` POST returns an extra challenge step
  a headless flow can't complete without interaction.
- VW is **actively redeploying** (that 502 is live churn). The Auth0 form fields or
  resume-chain hops may shift. Build the login to **fail loudly — dump the HTML on a
  parse miss** — so drift is a 5-minute fix, not a silent break.
- Make the redirect-walking robust (cap hops, carry cookies, resolve relative
  `Location`s). The exact intermediate hops in step 4 can vary; only the start
  (`/u/login`) and end (`weconnect://…#…`) are contractual.

---

## 9. ADDENDUM (2026-06/07) — hybrid flow disabled; current working flow

Shortly after this doc was written, VW disabled the **implicit grant** for the
WeConnect client (authorize with `code id_token token` now 500s with
"Grant type 'implicit' not allowed for the client"). Sections 3–5 above are
therefore superseded for token acquisition; the login-page mechanics
(Auth0 `/u/login`, browser UA, cookie-carrying redirect walk) are unchanged.

**Current live-verified flow (ported into this repo, `server/src/vw/api/`):**

1. `response_type=code` (pure authorization-code) + PKCE on
   `GET https://identity.vwgroup.io/oidc/v1/authorize`.
2. Same Auth0 `/u/login` scrape + POST as §3 (browser UA mandatory; 200 = bad
   password, 30x = success), same resume-chain walk to
   `weconnect://authenticated` — but the callback now carries `?code=…`
   (read both query and fragment).
3. Exchange the code at `POST https://emea.bff.cariad.digital/auth/v1/idk/oidc/token`
   — this endpoint recovered and **is** required now, with:
   - headers: `User-Agent: Volkswagen/3.61.0-android/14`,
     `x-android-package-name: com.volkswagen.weconnect`, `x-platform: android`,
     `x-qmauth: v1:01da27b0:<HMAC-SHA256(secret, floor(unix/100))>` (plain
     rotating HMAC, secret public in the VAG community — see `crypto.ts`),
     `x-assertion: 0`
   - body MUST echo `response_type=token id_token` alongside
     `grant_type=authorization_code`, `code`, `code_verifier`, `redirect_uri`,
     `client_id` — omitting the echo 502s upstream.
4. The exchange returns a **refresh_token**. Renew with
   `grant_type=refresh_token` (same headers + response_type echo); fall back to
   a full headless re-login only when refresh fails.
