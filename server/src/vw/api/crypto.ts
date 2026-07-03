import { randomBytes, createHash, createHmac } from "node:crypto";

// The CARIAD IDK token endpoint validates an "x-qmauth" app-integrity header: a
// time-rotating HMAC-SHA256 keyed by a per-app secret over floor(unixSeconds/100).
// Secret + client id are the VW Group app build's (id 01da27b0); shared across
// the IDK clients and published via the open-source VAG community (e.g. evcc
// vehicle/vag/idkproxy, ioBroker.vw-connect). This is plain HMAC, NOT device
// attestation — no Play Integrity involved.
const QM_SECRET_HEX = "1ab69925ac179aaa4e83abe671a9476d176418b85bd706f1436ca15be647989c";
const QM_CLIENT_ID = "01da27b0";

export function qmauthNow(nowMs: number = Date.now()): string {
  const ts = Math.floor(nowMs / 1000 / 100);
  const hmac = createHmac("sha256", Buffer.from(QM_SECRET_HEX, "hex"))
    .update(String(ts))
    .digest("hex");
  return `v1:${QM_CLIENT_ID}:${hmac}`;
}

function base64Url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomString(byteLen: number): string {
  return base64Url(randomBytes(byteLen));
}

export function sha256Base64Url(input: string): string {
  return base64Url(createHash("sha256").update(input).digest());
}

export function createPkcePair(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = randomString(64);
  const codeChallenge = sha256Base64Url(codeVerifier);
  return { codeVerifier, codeChallenge };
}
