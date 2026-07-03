export type Jar = Map<string, string>;
export interface DomainJars {
  myvw: Jar;
  vwgroup: Jar;
}

export function newJars(): DomainJars {
  return { myvw: new Map(), vwgroup: new Map() };
}

export function jarFor(jars: DomainJars, host: string): Jar {
  return host.endsWith("myvolkswagen.net") ? jars.myvw : jars.vwgroup;
}

export function mergeSetCookie(jar: Jar, headers: Headers): void {
  const list = headers.getSetCookie?.() ?? [];
  for (const c of list) {
    const [pair, ...attrs] = c.split(";");
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();

    // Max-Age=0 / an already-past Expires is a deletion, not a value — storing
    // it would keep re-sending "name=" and confuse the IDP's session handling.
    let expired = false;
    for (const attr of attrs) {
      const aEq = attr.indexOf("=");
      const key = (aEq > 0 ? attr.slice(0, aEq) : attr).trim().toLowerCase();
      const val = aEq > 0 ? attr.slice(aEq + 1).trim() : "";
      if (key === "max-age" && Number(val) <= 0) expired = true;
      if (key === "expires") {
        const when = new Date(val).getTime();
        if (!Number.isNaN(when) && when <= Date.now()) expired = true;
      }
    }

    if (expired) jar.delete(name);
    else jar.set(name, pair.slice(eq + 1).trim());
  }
}

export function cookieHeader(jar: Jar): string {
  return Array.from(jar.entries()).map(([k, v]) => `${k}=${v}`).join("; ");
}
