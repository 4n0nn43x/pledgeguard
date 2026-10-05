// Serves the PledgeGuard site (/) and the live party views (/app), and proxies the Canton
// JSON Ledger API under /api. One process, one URL, which is what a demo link needs.
// The browser never sees a credential: this process holds the OIDC token and adds it
// to every proxied call. Node 22, no dependencies.
//
//   node frontend/server.mjs            # DevNet, reads scripts/.devnet.env
//   ENV_FILE=... PORT=8090 node frontend/server.mjs
//
// For LocalNet, set LEDGER_URL and TOKEN in the env file instead of the OIDC fields.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { extname, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SITE = join(HERE, "../site");
const ENV_FILE = process.env.ENV_FILE ?? join(HERE, "../scripts/.devnet.env");
const env = Object.fromEntries(
  readFileSync(ENV_FILE, "utf8").split("\n")
    .filter((l) => l.includes("=") && !l.trimStart().startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"|"$/g, "")]; }),
);

const LEDGER = env.LEDGER_URL ?? "https://ledger-api-json.participant.hackcanton-01.devnet.naas.noders.services";
const OIDC = env.OIDC ?? "https://keycloak.naas.noders.services/realms/noders-appsfactory/protocol/openid-connect/token";
const CLIENT_ID = env.CLIENT_ID ?? "web-app-ui-hackcanton-01-devnet";
const PORT = Number(process.env.PORT ?? 8090);

// The demo parties, in the order the windows are shown.
const PARTIES = [
  { name: "Originator", key: "ORIGINATOR", role: "borrower, publishes the collateral fingerprint" },
  { name: "Lender A", key: "LENDER_A", role: "funds first" },
  { name: "Lender B", key: "LENDER_B", role: "funds against the same collateral" },
  { name: "Registry", key: "REGISTRY", role: "neutral, sees hashes, never a facility" },
  { name: "Auditor", key: "AUDITOR", role: "sees collisions and nothing else" },
].filter((p) => env[p.key]).map((p) => ({ ...p, party: env[p.key] }));

let cached = { token: env.TOKEN ?? null, until: env.TOKEN ? Infinity : 0 };
async function token() {
  if (Date.now() < cached.until) return cached.token;
  const res = await fetch(OIDC, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "password", client_id: CLIENT_ID,
      username: env.DEVNET_EMAIL, password: env.DEVNET_PASSWORD,
      scope: "openid daml_ledger_api offline_access",
    }),
  });
  if (!res.ok) throw new Error(`OIDC ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  cached = { token: j.access_token, until: Date.now() + (j.expires_in - 30) * 1000 };
  return cached.token;
}

const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".png": "image/png", ".svg": "image/svg+xml" };

createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    if (url.pathname === "/config") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ parties: PARTIES, ledger: LEDGER }));
    }
    if (url.pathname.startsWith("/api/")) {
      // The token can act as every demo party, so the public URL only relays the two reads the
      // views need. Anything else (submit, parties, users) would let a visitor move the lenders' coins.
      const route = `${req.method} ${url.pathname.slice(4)}`;
      if (route !== "POST /v2/state/active-contracts" && route !== "GET /v2/state/ledger-end") {
        res.writeHead(403, { "content-type": "text/plain" });
        return res.end("read-only demo proxy");
      }
      const body = req.method === "POST" ? await new Promise((r) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => r(b)); }) : undefined;
      const up = await fetch(LEDGER + url.pathname.slice(4) + url.search, {
        method: req.method,
        headers: { "content-type": "application/json", authorization: `Bearer ${await token()}` },
        body,
      });
      const text = await up.text();
      res.writeHead(up.status, { "content-type": "application/json" });
      return res.end(text);
    }
    // "/" is the site, "/app" the live views; assets are looked up in both roots.
    const name = url.pathname === "/" ? "index.html"
      : url.pathname === "/app" ? "__app__"
      : url.pathname.replace(/^\//, "").replace(/\.\./g, "");
    const candidates = name === "__app__"
      ? [join(HERE, "index.html")]
      : [join(SITE, name), join(HERE, name)];
    let data, file = name === "__app__" ? "index.html" : name;
    for (const c of candidates) {
      try { data = await readFile(c); break; } catch { /* try the next root */ }
    }
    if (!data) { const e = new Error(`not found: ${name}`); e.code = "ENOENT"; throw e; }
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(data);
  } catch (e) {
    res.writeHead(e.code === "ENOENT" ? 404 : 500, { "content-type": "text/plain" });
    res.end(String(e.message ?? e));
  }
}).listen(PORT, () => {
  console.log(`PledgeGuard on http://localhost:${PORT}   site /   live views /app   (ledger ${LEDGER.replace(/^https:\/\//, "")})`);
  console.log(PARTIES.map((p) => `  ${p.name.padEnd(11)} ${p.party}`).join("\n"));
});
