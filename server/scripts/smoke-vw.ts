// Manual live smoke test for the VW primary client.
// Usage: VW_USER=email VW_PASS=secret npm run smoke:vw
import { login } from "../src/vw/api/auth.js";
import { VwApiClient, type TokenStore } from "../src/vw/api/client.js";
import { extractSnapshot } from "../src/vw/api/extract.js";
import type { VwTokens } from "../src/vw/api/types.js";

const username = process.env.VW_USER;
const password = process.env.VW_PASS;
if (!username || !password) {
  console.error("Set VW_USER and VW_PASS env vars");
  process.exit(1);
}

let mem: VwTokens | null = null;
const store: TokenStore = {
  load: () => mem,
  save: (t) => {
    mem = t;
  },
  clear: () => {
    mem = null;
  },
};

const client = new VwApiClient(store, () => ({ username, password }));

console.log("Logging in…");
mem = await login(username, password);
console.log("OK — access token expires", new Date(mem.expiresAt).toISOString());

const vins = await client.listVehicles();
console.log("VINs:", vins);

if (vins.length > 0) {
  const data = await client.fetchIdData(vins[0]);
  console.log(JSON.stringify(extractSnapshot(data, new Date().toISOString()), null, 2));
}
