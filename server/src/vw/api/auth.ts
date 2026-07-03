import { createPkcePair, qmauthNow, randomString } from "./crypto.js";
import { type CookieJar, followRedirect, resolveUrl } from "./cookies.js";
import {
  VW_ANDROID_PACKAGE_NAME,
  VW_CLIENT_ID,
  VW_HOST_BFF,
  VW_HOST_IDP,
  VW_REDIRECT_URI,
  VW_RESPONSE_TYPE,
  VW_SCOPE,
  VW_USER_AGENT,
  type VwTokens,
} from "./types.js";

// The Auth0 login form carries a single hidden field we must echo back: `state`.
// (No hmac/_csrf/relayState — those belonged to the retired signin-service flow.)
function extractStateField(html: string): string | null {
  const m =
    html.match(/<input[^>]+name=["']state["'][^>]+value=["']([^"']+)["']/i) ??
    html.match(/<input[^>]+value=["']([^"']+)["'][^>]+name=["']state["']/i);
  return m ? m[1] : null;
}

/**
 * Headless login against identity.vwgroup.io (Auth0 Universal Login) using the
 * authorization-code flow + PKCE, then code exchange at the CARIAD BFF.
 * Fails loudly with HTML dumps on parse misses so VW-side drift is quick to
 * diagnose. Pure network — persistence is the caller's job.
 */
export async function login(username: string, password: string): Promise<VwTokens> {
  const jar: CookieJar = new Map();
  const { codeVerifier, codeChallenge } = createPkcePair();
  const state = randomString(16);
  const nonce = randomString(16);

  const authorizeUrl =
    `${VW_HOST_IDP}/oidc/v1/authorize?` +
    new URLSearchParams({
      client_id: VW_CLIENT_ID,
      redirect_uri: VW_REDIRECT_URI,
      response_type: VW_RESPONSE_TYPE,
      scope: VW_SCOPE,
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    }).toString();

  // Step 1: GET authorize, follow redirects to the Auth0 /u/login HTML page.
  let currentUrl = authorizeUrl;
  let loginUrl = "";
  let loginHtml = "";
  for (let i = 0; i < 8; i++) {
    const r = await followRedirect(currentUrl, jar);
    if (r.status >= 300 && r.status < 400 && r.location) {
      currentUrl = resolveUrl(r.location, currentUrl);
      continue;
    }
    if (r.status === 200 && currentUrl.includes("/u/login")) {
      loginUrl = currentUrl;
      loginHtml = r.body;
      break;
    }
    throw new Error(
      `Unexpected authorize response: status=${r.status} url=${currentUrl}\n${r.body.slice(0, 800)}`
    );
  }
  if (!loginUrl) throw new Error("Did not reach the VW /u/login page within 8 hops");

  // Step 2: POST credentials to the Auth0 login form.
  const formState =
    extractStateField(loginHtml) ?? new URL(loginUrl).searchParams.get("state");
  if (!formState) {
    throw new Error(
      `VW login page changed: no 'state' field found.\n--- HTML ---\n${loginHtml.slice(0, 4000)}\n--- END ---`
    );
  }

  const loginBody = new URLSearchParams({
    state: formState,
    username,
    password,
    action: "default",
  });
  let r = await followRedirect(loginUrl, jar, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: VW_HOST_IDP,
      Referer: loginUrl,
    },
    body: loginBody.toString(),
  });

  // Auth0 re-renders the login page (HTTP 200) on bad credentials instead of
  // redirecting. A successful login replies 30x toward /authorize/resume.
  if (r.status === 200) {
    throw new Error(
      `Login rejected (likely wrong password). Got 200 at /u/login instead of a redirect.\n${r.body.slice(0, 600)}`
    );
  }

  // Step 3: follow the resume chain until the weconnect:// callback.
  currentUrl = r.location ? resolveUrl(r.location, loginUrl) : "";
  let finalUrl = "";
  for (let i = 0; i < 15 && currentUrl; i++) {
    if (currentUrl.startsWith(VW_REDIRECT_URI)) {
      finalUrl = currentUrl;
      break;
    }
    r = await followRedirect(currentUrl, jar);
    if (r.status >= 300 && r.status < 400 && r.location) {
      currentUrl = resolveUrl(r.location, currentUrl);
      continue;
    }
    throw new Error(
      `Auth resume chain stopped unexpectedly: status=${r.status} url=${currentUrl}`
    );
  }
  if (!finalUrl) throw new Error("Did not reach the weconnect:// callback within 15 hops");

  // Step 4: extract the authorization code from the callback. Auth0 may use the
  // query or the fragment for native redirect URIs — read both.
  const cbParams = new URLSearchParams();
  const qPart = finalUrl.includes("?") ? finalUrl.split("?")[1].split("#")[0] : "";
  const fPart = finalUrl.includes("#") ? finalUrl.split("#")[1] : "";
  for (const part of [qPart, fPart]) {
    if (!part) continue;
    for (const [k, v] of new URLSearchParams(part)) cbParams.set(k, v);
  }
  const code = cbParams.get("code");
  const returnedState = cbParams.get("state");
  if (!code) {
    throw new Error(`Callback missing authorization code: ${finalUrl.slice(0, 200)}`);
  }
  if (returnedState && returnedState !== state) {
    throw new Error(`OIDC state mismatch: expected ${state}, got ${returnedState}`);
  }

  return exchangeCode(code, codeVerifier);
}

/** Swap an authorization code (or a refresh token) for a token set at the BFF. */
async function postToken(body: URLSearchParams): Promise<VwTokens> {
  const resp = await fetch(`${VW_HOST_BFF}/auth/v1/idk/oidc/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "Accept-Charset": "utf-8",
      "User-Agent": VW_USER_AGENT,
      "x-android-package-name": VW_ANDROID_PACKAGE_NAME,
      "x-platform": "android",
      "x-qmauth": qmauthNow(),
      "x-assertion": "0",
    },
    body: body.toString(),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Token request failed: ${resp.status} ${text.slice(0, 400)}`);
  }
  const tj = (await resp.json()) as {
    access_token?: string;
    id_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!tj.access_token) {
    throw new Error(`Token response missing access_token: ${JSON.stringify(tj).slice(0, 200)}`);
  }
  return {
    accessToken: tj.access_token,
    idToken: tj.id_token ?? "",
    refreshToken: tj.refresh_token,
    expiresAt: Date.now() + (tj.expires_in ?? 3600) * 1000,
  };
}

async function exchangeCode(code: string, codeVerifier: string): Promise<VwTokens> {
  return postToken(
    new URLSearchParams({
      grant_type: "authorization_code",
      // The IDK token endpoint expects response_type echoed in the exchange body
      // (matches the Android app / evcc idkproxy); omitting it 502s upstream.
      response_type: "token id_token",
      code,
      code_verifier: codeVerifier,
      redirect_uri: VW_REDIRECT_URI,
      client_id: VW_CLIENT_ID,
    })
  );
}

/** Renew an access token using a stored refresh token (no full re-login). */
export async function refreshAccessToken(refreshToken: string): Promise<VwTokens> {
  return postToken(
    new URLSearchParams({
      grant_type: "refresh_token",
      // Same IDK quirk as exchangeCode: the endpoint expects response_type
      // echoed in the body and 502s without it.
      response_type: "token id_token",
      refresh_token: refreshToken,
      client_id: VW_CLIENT_ID,
    })
  );
}
