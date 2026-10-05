// Serves the PledgeGuard site (/) and the dashboard (/app), proxies the reads of the Canton JSON
// Ledger API under /api, and runs the workflow actions under /act. One process, one URL.
// The browser never sees a credential: this process holds the OIDC token. Node 22, no dependencies.
//
//   node frontend/server.mjs            # DevNet, reads scripts/.devnet.env
//   ENV_FILE=... PORT=8090 node frontend/server.mjs
//
// Env file: the party ids (ORIGINATOR, LENDER_A, LENDER_B, REGISTRY, OPS, AUDITOR), DEVNET_EMAIL and
// DEVNET_PASSWORD (or LEDGER_URL + TOKEN on LocalNet). Actions are enabled only when DEMO_PASSWORD and
// SESSION_SECRET (32+ chars) are set; otherwise the dashboard is read-only. Optional: INSTRUMENT
// (amulet | cbtc | mock), TOKEN_REGISTRY_URL, PACKAGE_PREFERENCE, MAX_DRAW, MAX_FUND.
//
// Security model: the token can act as every demo party, so the browser never chooses a party or a
// command. /api relays two reads only; /act runs a fixed set of validated actions, behind a signed
// session cookie, one at a time, with a per-session rate limit.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { extname, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { tokenProvider, tokenSubject } from "../backend/oidc.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SITE = join(HERE, "../site");
const ENV_FILE = process.env.ENV_FILE ?? join(HERE, "../scripts/.devnet.env");
const env = Object.fromEntries(
  readFileSync(ENV_FILE, "utf8").split("\n")
    .filter((l) => l.includes("=") && !l.trimStart().startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"|"$/g, "")]; }),
);

const LEDGER = env.LEDGER_URL ?? "https://ledger-api-json.participant.hackcanton-01.devnet.naas.noders.services";
const PORT = Number(process.env.PORT ?? 8090);
const token = tokenProvider(env);

// The demo parties, in the order the windows are shown.
const PARTIES = [
  { name: "Originator", key: "ORIGINATOR", role: "borrower, publishes the collateral fingerprint" },
  { name: "Lender A", key: "LENDER_A", role: "funds first" },
  { name: "Lender B", key: "LENDER_B", role: "funds against the same collateral" },
  { name: "Registry", key: "REGISTRY", role: "neutral, sees hashes, never a facility" },
  { name: "Auditor", key: "AUDITOR", role: "sees collisions and nothing else" },
].filter((p) => env[p.key]).map((p) => ({ ...p, party: env[p.key] }));
const P = Object.fromEntries(PARTIES.map((p) => [p.key, p.party]));

// ---- instrument (CIP-56 token standard registry)
const INSTRUMENT = env.INSTRUMENT ?? "amulet";
const CBTC_ADMIN = env.CBTC_ADMIN ?? "cbtc-network::12202a83c6f4082217c175e29bc53da5f2703ba2675778ab99217a5a881a949203ff";
const TOKEN_REGISTRY = (env.TOKEN_REGISTRY_URL ?? (INSTRUMENT === "cbtc"
  ? `https://api.utilities.digitalasset-dev.com/api/token-standard/v0/registrars/${CBTC_ADMIN}`
  : "https://scan.sv-1.dev.global.canton.network.digitalasset.com")).replace(/\/$/, "");
const INSTRUMENT_ID = INSTRUMENT === "cbtc" ? "CBTC" : "Amulet";
const UNIT = INSTRUMENT === "cbtc" ? "cBTC" : "CC";
const MAX_DRAW = Number(env.MAX_DRAW ?? 50);
const MAX_FUND = Number(env.MAX_FUND ?? 100);
const PKG_PREF = (env.PACKAGE_PREFERENCE ?? "").split(",").filter(Boolean);

const T = {
  fp: "#pledgeguard:PledgeGuard.Registry:CollateralFingerprint",
  prop: "#pledgeguard:PledgeGuard.Lending:FacilityProposal",
  fac: "#pledgeguard:PledgeGuard.Lending:Facility",
  draw: "#pledgeguard:PledgeGuard.Lending:DrawRequest",
  claim: "#pledgeguard:PledgeGuard.Registry:Claim",
  deleg: "#pledgeguard:PledgeGuard.Delegation:RegistryDelegation",
  mock: "#pledgeguard-test:PledgeGuard.Test.Scenario:MockAllocation",
  holding: "#splice-api-token-holding-v1:Splice.Api.Token.HoldingV1:Holding",
  alloc: "#splice-api-token-allocation-v1:Splice.Api.Token.AllocationV1:Allocation",
  allocFactory: "#splice-api-token-allocation-instruction-v1:Splice.Api.Token.AllocationInstructionV1:AllocationFactory",
  transferFactory: "#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferFactory",
  transferInstr: "#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferInstruction",
};

// ---- ledger
async function ledger(path, body, method = "POST") {
  const r = await fetch(LEDGER + path, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${await token()}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) throw Object.assign(new Error(ledgerError(text)), { status: 502 });
  return text ? JSON.parse(text) : undefined;
}
// The ledger's own refusal is the useful part (e.g. a Daml assertion); keep it short.
const ledgerError = (text) => { try { const j = JSON.parse(text); return String(j.cause ?? j.message ?? text).slice(0, 300); } catch { return text.slice(0, 300); } };

let USER_ID = env.USER_ID;
const wildcard = (party) => ({ [party]: { cumulative: [{ identifierFilter: { WildcardFilter: { value: { includeCreatedEventBlob: false } } } }] } });

async function submit(actAs, commands, disclosedContracts = []) {
  USER_ID ??= tokenSubject(await token());
  const { transaction: tx } = await ledger("/v2/commands/submit-and-wait-for-transaction", {
    commands: { commands, commandId: `pg-web-${randomUUID()}`, actAs: [actAs], userId: USER_ID, disclosedContracts, packageIdSelectionPreference: PKG_PREF },
    transactionFormat: { transactionShape: "TRANSACTION_SHAPE_LEDGER_EFFECTS", eventFormat: { filtersByParty: wildcard(actAs), verbose: false } },
  });
  return {
    updateId: tx.updateId, offset: tx.offset,
    created: tx.events.map((e) => e.CreatedEvent).filter(Boolean).map((e) => ({ templateId: e.templateId, contractId: e.contractId })),
  };
}
const create = (as, templateId, createArguments) => submit(as, [{ CreateCommand: { templateId, createArguments } }]);
const exercise = (as, templateId, contractId, choice, choiceArgument, disclosed) =>
  submit(as, [{ ExerciseCommand: { templateId, contractId, choice, choiceArgument } }], disclosed);
const createdOf = (tx, test) => tx.created.find((c) => test(c.templateId))?.contractId;

// ---- token standard: holdings, allocations, transfers, all through the instrument's own registry
const EMPTY_EXTRA = { context: { values: {} }, meta: { values: {} } };
const iso = (ms = 0) => new Date(Date.now() + ms).toISOString().replace(/\.\d+Z$/, "Z");
const disclosedOf = (ctx) => (ctx?.disclosedContracts ?? []).map(({ templateId, contractId, createdEventBlob, synchronizerId }) => ({ templateId, contractId, createdEventBlob, synchronizerId }));

async function registry(path, body = {}) {
  const r = await fetch(TOKEN_REGISTRY + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw Object.assign(new Error(`token registry ${r.status}: ${(await r.text()).slice(0, 200)}`), { status: 502 });
  return r.json();
}
let ADMIN = INSTRUMENT === "cbtc" ? CBTC_ADMIN : null;
async function admin() {
  if (ADMIN) return ADMIN;
  const r = await fetch(`${TOKEN_REGISTRY}/registry/metadata/v1/info`);
  if (!r.ok) throw Object.assign(new Error(`token registry ${r.status}`), { status: 502 });
  return (ADMIN = (await r.json()).adminId);
}

async function holdings(party) {
  const { offset } = await ledger("/v2/state/ledger-end", undefined, "GET");
  const rows = await ledger("/v2/state/active-contracts", {
    activeAtOffset: offset, verbose: false,
    eventFormat: { filtersByParty: { [party]: { cumulative: [{ identifierFilter: { InterfaceFilter: { value: { interfaceId: T.holding, includeInterfaceView: true, includeCreatedEventBlob: false } } } }] } }, verbose: false },
  });
  return rows.map((r) => r.contractEntry?.JsActiveContract?.createdEvent).filter(Boolean)
    .map((e) => ({ cid: e.contractId, v: e.interfaceViews?.[0]?.viewValue }))
    .filter(({ v }) => v && v.owner === party && !v.lock && v.instrumentId?.id === INSTRUMENT_ID)
    .map(({ cid, v }) => ({ cid, amount: Number(v.amount) }));
}

async function allocate(lender, amount, ref) {
  if (INSTRUMENT === "mock") {
    const tx = await create(lender, T.mock, { executor: P.REGISTRY, sender: lender, receiver: P.ORIGINATOR, amount });
    return { tx, cid: createdOf(tx, (t) => t.endsWith(":MockAllocation")) };
  }
  const a = await admin(), now = iso(), later = iso(24 * 3600e3);
  const args = {
    expectedAdmin: a,
    allocation: {
      settlement: { executor: P.REGISTRY, settlementRef: { id: ref, cid: null }, requestedAt: now, allocateBefore: later, settleBefore: later, meta: { values: {} } },
      transferLegId: "draw",
      transferLeg: { sender: lender, receiver: P.ORIGINATOR, amount, instrumentId: { admin: a, id: INSTRUMENT_ID }, meta: { values: {} } },
    },
    requestedAt: now,
    inputHoldingCids: (await holdings(lender)).map((h) => h.cid),
    extraArgs: EMPTY_EXTRA,
  };
  const f = await registry("/registry/allocation-instruction/v1/allocation-factory", { choiceArguments: args });
  const tx = await exercise(lender, T.allocFactory, f.factoryId, "AllocationFactory_Allocate",
    { ...args, extraArgs: { context: f.choiceContext.choiceContextData, meta: { values: {} } } }, disclosedOf(f.choiceContext));
  return { tx, cid: createdOf(tx, (t) => t.includes("AmuletAllocation") || t.endsWith(":Allocation")) };
}

// Canton Coin for a lender, from the wallet party of this ledger user (filled with the wallet's TAP).
async function fund(to, amount) {
  USER_ID ??= tokenSubject(await token());
  const from = `${USER_ID}::${P.REGISTRY.split("::")[1]}`;
  const a = await admin(), now = iso(), later = iso(24 * 3600e3);
  const args = {
    expectedAdmin: a,
    transfer: { sender: from, receiver: to, amount, instrumentId: { admin: a, id: INSTRUMENT_ID }, requestedAt: now, executeBefore: later,
      inputHoldingCids: (await holdings(from)).map((h) => h.cid), meta: { values: {} } },
    extraArgs: EMPTY_EXTRA,
  };
  const f = await registry("/registry/transfer-instruction/v1/transfer-factory", { choiceArguments: args });
  let tx = await exercise(from, T.transferFactory, f.factoryId, "TransferFactory_Transfer",
    { ...args, extraArgs: { context: f.choiceContext.choiceContextData, meta: { values: {} } } }, disclosedOf(f.choiceContext));
  const instr = createdOf(tx, (t) => t.includes("TransferInstruction"));
  if (instr) { // two-step transfer: the receiver accepts
    const c = await registry(`/registry/transfer-instruction/v1/${encodeURIComponent(instr)}/choice-contexts/accept`);
    tx = await exercise(to, T.transferInstr, instr, "TransferInstruction_Accept", { extraArgs: { context: c.choiceContextData, meta: { values: {} } } }, disclosedOf(c));
  }
  return tx;
}

// ---- actions: every input validated here, every party chosen here
const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
const need = (ok, msg) => { if (!ok) throw bad(msg); };
const cid = (v, what = "contract id") => { need(typeof v === "string" && /^[0-9a-f]{40,600}$/.test(v), `invalid ${what}`); return v; };
const lender = (k) => { need(k === "LENDER_A" || k === "LENDER_B", "unknown lender"); return P[k]; };
const decimal = (v, max, what) => {
  const n = Number(v);
  need((typeof v === "string" || typeof v === "number") && Number.isFinite(n) && n > 0 && n <= max, `${what} must be above 0 and at most ${max}`);
  return n.toFixed(4);
};
const hash = (v) => { need(typeof v === "string" && /^[0-9a-f]{64}$/.test(v), "the fingerprint must be a sha256 in lowercase hex"); return v; };
const schema = (v) => { need(typeof v === "string" && /^[a-z0-9-]{1,40}$/.test(v), "invalid schema id"); return v; };

// The fingerprint of the scenario being played, so a visitor who just arrived follows the same run.
let inPlay = null;

const ACTIONS = {
  fingerprint: async (b) => {
    const tx = await create(P.ORIGINATOR, T.fp, { originator: P.ORIGINATOR, registry: P.REGISTRY, schemaId: schema(b.schemaId), hash: hash(b.hash) });
    inPlay = b.hash;
    return tx;
  },
  propose: (b) => {
    const l = lender(b.lender);
    need(typeof b.maturity === "string" && /^\d{4}-\d{2}-\d{2}$/.test(b.maturity) && Date.parse(b.maturity) > Date.now(), "maturity must be a future date");
    return create(l, T.prop, {
      lender: l, originator: P.ORIGINATOR, registry: P.REGISTRY, schemaId: schema(b.schemaId), hash: hash(b.hash),
      amount: decimal(b.amount, 1e12, "facility amount"), rate: decimal(b.rate, 1, "rate"), maturity: `${b.maturity}T00:00:00Z`,
    });
  },
  accept: (b) => exercise(P.ORIGINATOR, T.prop, cid(b.proposalCid), "FacilityProposal_Accept", {}),
  draw: async (b) => {
    const l = lender(b.lender), fac = cid(b.facilityCid);
    const { cid: allocationCid } = await allocate(l, decimal(b.amount, MAX_DRAW, "draw"), `pledgeguard-draw-${fac.slice(0, 16)}`);
    need(allocationCid, "the token registry created no allocation");
    return exercise(l, T.fac, fac, "Facility_RequestDraw", { allocationCid });
  },
  release: (b) => exercise(lender(b.lender), T.claim, cid(b.claimCid), "Claim_Release", {}),
  cancel: (b) => exercise(lender(b.lender), T.draw, cid(b.drawCid), "DrawRequest_Withdraw", {}),
  unlock: async (b) => { // give back the funds of an allocation that will not settle (a collided draw)
    const l = lender(b.lender), a = cid(b.allocationCid);
    const c = INSTRUMENT === "mock" ? { choiceContextData: { values: {} } } : await registry(`/registry/allocations/v1/${encodeURIComponent(a)}/choice-contexts/withdraw`);
    return exercise(l, T.alloc, a, "Allocation_Withdraw", { extraArgs: { context: c.choiceContextData, meta: { values: {} } } }, disclosedOf(c));
  },
  fund: (b) => { need(INSTRUMENT === "amulet", "funding is wired for Canton Coin only"); return fund(lender(b.lender), decimal(b.amount, MAX_FUND, "amount")); },
  grant: () => create(P.REGISTRY, T.deleg, { registry: P.REGISTRY, ops: P.OPS }),
  revoke: (b) => exercise(P.REGISTRY, T.deleg, cid(b.delegationCid), "Delegation_Revoke", {}),
};

// ---- auth: one demo password, a signed session cookie, nothing stored server side
const WRITABLE = Boolean(env.DEMO_PASSWORD && (env.SESSION_SECRET ?? "").length >= 32);
const SESSION_MS = 8 * 3600e3;
const sign = (v) => createHmac("sha256", env.SESSION_SECRET).update(v).digest("base64url");
const same = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
function session(req) {
  if (!WRITABLE) return null;
  const m = /(?:^|;\s*)pg_session=([\w-]+)\.([\w-]+)\.([\w-]+)/.exec(req.headers.cookie ?? "");
  if (!m || !same(m[3], sign(`${m[1]}.${m[2]}`)) || Number(m[1]) < Date.now()) return null;
  return { id: m[2] };
}
const cookie = (v, maxAge) => `pg_session=${v}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
// Caddy replaces any client-sent X-Forwarded-For (no trusted proxies), so its first entry is the client.
const clientIp = (req) => (req.headers["x-forwarded-for"] ?? "").split(",")[0].trim() || req.socket.remoteAddress;

// ponytail: in-memory counters, reset on restart; enough for one demo instance
const hits = new Map();
function limited(key, max, windowMs) {
  const now = Date.now(), h = hits.get(key);
  if (!h || h.until < now) { hits.set(key, { n: 1, until: now + windowMs }); return false; }
  return ++h.n > max;
}

// Writes go one at a time: two draws in parallel would spend the same holdings.
let queue = Promise.resolve();
const serial = (fn) => { const run = queue.then(fn); queue = run.catch(() => {}); return run; };

// ---- balances, cached briefly: every open dashboard polls them
let balances = { at: 0, value: null };
async function getBalances() {
  if (Date.now() - balances.at < 5000 && balances.value) return balances.value;
  const keys = ["ORIGINATOR", "LENDER_A", "LENDER_B"].filter((k) => P[k]);
  const sums = await Promise.all(keys.map(async (k) => (await holdings(P[k])).reduce((s, h) => s + h.amount, 0)));
  balances = { at: Date.now(), value: Object.fromEntries(keys.map((k, i) => [k, sums[i]])) };
  return balances.value;
}

// ---- http
const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".png": "image/png", ".svg": "image/svg+xml" };
const json = (res, status, body, headers = {}) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers }); res.end(JSON.stringify(body)); };
const readBody = (req, limit = 16_384) => new Promise((resolve, reject) => {
  let b = "";
  req.on("data", (c) => { b += c; if (b.length > limit) { reject(bad("body too large")); req.destroy(); } });
  req.on("end", () => resolve(b));
});
const readJson = async (req) => { try { return JSON.parse((await readBody(req)) || "{}"); } catch (e) { throw e.status ? e : bad("invalid JSON"); } };
// CSRF: SameSite=Strict already keeps the cookie off cross-site requests; also refuse foreign origins.
const sameOrigin = (req) => !req.headers.origin || new URL(req.headers.origin).host === req.headers.host;

createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    if (url.pathname === "/config") {
      return json(res, 200, { parties: PARTIES, ledger: LEDGER, writable: WRITABLE, instrument: INSTRUMENT, unit: UNIT, maxDraw: MAX_DRAW, maxFund: MAX_FUND });
    }
    if (url.pathname === "/state") return json(res, 200, { balances: await getBalances(), hash: inPlay });

    if (url.pathname.startsWith("/auth/") || url.pathname.startsWith("/act/")) {
      if (url.pathname === "/auth/me") return json(res, 200, { signedIn: Boolean(session(req)), writable: WRITABLE });
      if (req.method !== "POST") return json(res, 405, { error: "POST only" });
      if (!sameOrigin(req) || !String(req.headers["content-type"]).startsWith("application/json")) return json(res, 403, { error: "cross-origin or non-JSON request refused" });
      if (!WRITABLE) return json(res, 403, { error: "this instance is read-only" });

      if (url.pathname === "/auth/login") {
        const ip = clientIp(req);
        if (limited(`login:${ip}`, 10, 15 * 60e3)) return json(res, 429, { error: "too many attempts, wait 15 minutes" });
        const { password } = await readJson(req);
        const digest = (s) => createHash("sha256").update(String(s ?? "")).digest("base64url");
        if (!same(digest(password), digest(env.DEMO_PASSWORD))) return json(res, 401, { error: "wrong password" });
        const v = `${Date.now() + SESSION_MS}.${randomBytes(12).toString("base64url")}`;
        return json(res, 200, { signedIn: true }, { "set-cookie": cookie(`${v}.${sign(v)}`, SESSION_MS / 1000) });
      }
      if (url.pathname === "/auth/logout") return json(res, 200, { signedIn: false }, { "set-cookie": cookie("x.x.x", 0) });

      const s = session(req);
      if (!s) return json(res, 401, { error: "sign in first" });
      const action = ACTIONS[url.pathname.slice(5)];
      if (!Object.hasOwn(ACTIONS, url.pathname.slice(5))) return json(res, 404, { error: "unknown action" });
      if (limited(`act:${s.id}`, 30, 60e3)) return json(res, 429, { error: "slow down: 30 actions a minute" });
      const body = await readJson(req);
      const tx = await serial(() => action(body));
      balances.at = 0;
      return json(res, 200, { ok: true, updateId: tx.updateId, offset: tx.offset, created: tx.created });
    }

    if (url.pathname.startsWith("/api/")) {
      // The token can act as every demo party, so /api only relays the two reads the views need.
      const route = `${req.method} ${url.pathname.slice(4)}`;
      if (route !== "POST /v2/state/active-contracts" && route !== "GET /v2/state/ledger-end") {
        res.writeHead(403, { "content-type": "text/plain" });
        return res.end("read-only demo proxy");
      }
      const body = req.method === "POST" ? await readBody(req) : undefined;
      const up = await fetch(LEDGER + url.pathname.slice(4) + url.search, {
        method: req.method,
        headers: { "content-type": "application/json", authorization: `Bearer ${await token()}` },
        body,
      });
      const text = await up.text();
      res.writeHead(up.status, { "content-type": "application/json" });
      return res.end(text);
    }

    // "/" is the site, "/app" the dashboard; assets are looked up in both roots.
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
    if (url.pathname.startsWith("/act/") || url.pathname.startsWith("/auth/") || url.pathname === "/state") {
      return json(res, e.status ?? 500, { error: String(e.message ?? e) });
    }
    res.writeHead(e.code === "ENOENT" ? 404 : 500, { "content-type": "text/plain" });
    res.end(String(e.message ?? e));
  }
}).listen(PORT, () => {
  console.log(`PledgeGuard on http://localhost:${PORT}   site /   dashboard /app   (ledger ${LEDGER.replace(/^https:\/\//, "")})`);
  console.log(`actions ${WRITABLE ? `enabled, settling in ${UNIT}` : "disabled (set DEMO_PASSWORD and SESSION_SECRET)"}`);
  console.log(PARTIES.map((p) => `  ${p.name.padEnd(11)} ${p.party}`).join("\n"));
});
