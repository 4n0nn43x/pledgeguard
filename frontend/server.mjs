// Serves the PledgeGuard site (/) and the platform (/app): one sign-in per organisation, each one
// reading its own ledger contracts and acting in its own role, plus a public visibility matrix.
// The browser never sees a ledger credential: this process holds the OIDC token. Node 22, no dependencies.
//
//   node frontend/server.mjs            # DevNet, reads scripts/.devnet.env
//   ENV_FILE=... PORT=8090 node frontend/server.mjs
//
// Env file: the party ids (ORIGINATOR, LENDER_A, LENDER_B, REGISTRY, OPS, AUDITOR), DEVNET_EMAIL and
// DEVNET_PASSWORD (or LEDGER_URL + TOKEN on LocalNet), SESSION_SECRET (32+ chars) and one sign-in
// password per organisation: PASSWORD_ORIGINATOR, PASSWORD_LENDER_A, PASSWORD_LENDER_B,
// PASSWORD_REGISTRY, PASSWORD_AUDITOR. Optional: INSTRUMENT (amulet | cbtc | mock), TOKEN_REGISTRY_URL,
// PACKAGE_PREFERENCE, MAX_DRAW, MAX_FUND.
//
// Security model: the ledger token can act as every party of this deployment, so the browser never
// chooses a party or a command. The session names the organisation; the server reads that party's
// contracts only and runs the fixed actions of its role, validated, one at a time, rate limited.

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

// The organisations of this deployment, each one a party on its own and a sign-in of its own.
const ORGS = [
  { key: "ORIGINATOR", label: "Borrower", blurb: "Pledges its receivables and registers their fingerprint" },
  { key: "LENDER_A", label: "First lender", blurb: "Finances the borrower against the collateral" },
  { key: "LENDER_B", label: "Second lender", blurb: "Finances the borrower against the collateral" },
  { key: "REGISTRY", label: "Registry operator", blurb: "Checks every draw against live pledges, sees fingerprints, never loan terms" },
  { key: "AUDITOR", label: "Auditor", blurb: "Sees the double pledges that were stopped, nothing else" },
].filter((o) => env[o.key]).map((o) => ({ ...o, party: env[o.key] }));
const P = Object.fromEntries(ORGS.map((o) => [o.key, o.party]));
P.OPS = env.OPS;   // the registry's automation party: not an organisation, no sign-in, but the delegation names it
const LENDERS = ["LENDER_A", "LENDER_B"];

// ---- instrument (Canton token standard registry)
const INSTRUMENT = env.INSTRUMENT ?? "amulet";
const CBTC_ADMIN = env.CBTC_ADMIN ?? "cbtc-network::12202a83c6f4082217c175e29bc53da5f2703ba2675778ab99217a5a881a949203ff";
// One or more registry base URLs, comma separated: a scan that lags behind the network answers 404 for a
// contract the others already see, so the next one is tried.
const TOKEN_REGISTRIES = (env.TOKEN_REGISTRY_URL ?? (INSTRUMENT === "cbtc"
  ? `https://api.utilities.digitalasset-dev.com/api/token-standard/v0/registrars/${CBTC_ADMIN}`
  : "https://scan.sv-1.dev.global.canton.network.digitalasset.com,https://scan.sv-2.dev.global.canton.network.digitalasset.com"))
  .split(",").map((u) => u.trim().replace(/\/$/, "")).filter(Boolean);
const TOKEN_REGISTRY = TOKEN_REGISTRIES[0];
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
  let err;
  for (const base of TOKEN_REGISTRIES) {
    try {
      const r = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
      if (r.ok) return r.json();
      err = Object.assign(new Error(`token registry ${r.status}: ${(await r.text()).slice(0, 200)}`), { status: 502 });
    } catch (e) { err = e.status ? e : Object.assign(new Error(`token registry unreachable: ${e.message}`), { status: 502 }); }
  }
  throw err;
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
  const treasury = (await holdings(from)).reduce((n, h) => n + h.amount, 0);
  need(treasury - Number(amount) >= FUND_FLOOR, "the treasury is at its floor: top-ups are paused");
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
    // the token registry indexes the new instruction a few seconds after the ledger: retry its 404 briefly
    let c;
    for (let i = 0; ; i++) {
      try { c = await registry(`/registry/transfer-instruction/v1/${encodeURIComponent(instr)}/choice-contexts/accept`); break; }
      catch (e) { if (i >= 9 || !/ 404/.test(e.message)) throw e; await new Promise((r) => setTimeout(r, 1500)); }
    }
    tx = await exercise(to, T.transferInstr, instr, "TransferInstruction_Accept", { extraArgs: { context: c.choiceContextData, meta: { values: {} } } }, disclosedOf(c));
  }
  return tx;
}

// ---- actions: every input validated here, every party chosen here
const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
const need = (ok, msg) => { if (!ok) throw bad(msg); };
const cid = (v, what = "contract id") => { need(typeof v === "string" && /^[0-9a-f]{40,600}$/.test(v), `invalid ${what}`); return v; };
const decimal = (v, max, what) => {
  const n = Number(v);
  need((typeof v === "string" || typeof v === "number") && Number.isFinite(n) && n > 0 && n <= max, `${what} must be above 0 and at most ${max}`);
  return n.toFixed(4);
};
const hash = (v) => { need(typeof v === "string" && /^[0-9a-f]{64}$/.test(v), "the fingerprint must be a sha256 in lowercase hex"); return v; };
const schema = (v) => { need(typeof v === "string" && /^[a-z0-9-]{1,40}$/.test(v), "invalid schema id"); return v; };

// Each organisation runs the actions of its role, as itself. `org` comes from the session, never the body.
const ROLE = {
  fingerprint: ["ORIGINATOR"], accept: ["ORIGINATOR"],
  propose: LENDERS, draw: LENDERS, release: LENDERS, cancel: LENDERS, unlock: LENDERS, fund: LENDERS,
  grant: ["REGISTRY"], revoke: ["REGISTRY"],
};
const ACTIONS = {
  fingerprint: (b) => create(P.ORIGINATOR, T.fp, { originator: P.ORIGINATOR, registry: P.REGISTRY, schemaId: schema(b.schemaId), hash: hash(b.hash) }),
  propose: (b, org) => {
    const l = P[org];
    need(typeof b.maturity === "string" && /^\d{4}-\d{2}-\d{2}$/.test(b.maturity) && Date.parse(b.maturity) > Date.now(), "maturity must be a future date");
    return create(l, T.prop, {
      lender: l, originator: P.ORIGINATOR, registry: P.REGISTRY, schemaId: schema(b.schemaId), hash: hash(b.hash),
      amount: decimal(b.amount, 1e12, "facility amount"), rate: decimal(b.rate, 1, "rate"), maturity: `${b.maturity}T00:00:00Z`,
    });
  },
  accept: (b) => exercise(P.ORIGINATOR, T.prop, cid(b.proposalCid), "FacilityProposal_Accept", {}),
  draw: async (b, org) => {
    const l = P[org], fac = cid(b.facilityCid);
    const { cid: allocationCid } = await allocate(l, decimal(b.amount, MAX_DRAW, "draw"), `pledgeguard-draw-${fac.slice(0, 16)}`);
    need(allocationCid, "the token registry created no allocation");
    return exercise(l, T.fac, fac, "Facility_RequestDraw", { allocationCid });
  },
  release: (b, org) => exercise(P[org], T.claim, cid(b.claimCid), "Claim_Release", {}),
  cancel: (b, org) => exercise(P[org], T.draw, cid(b.drawCid), "DrawRequest_Withdraw", {}),
  unlock: async (b, org) => { // give back the funds of an allocation that will not settle (a stopped draw)
    const a = cid(b.allocationCid);
    const c = INSTRUMENT === "mock" ? { choiceContextData: { values: {} } } : await registry(`/registry/allocations/v1/${encodeURIComponent(a)}/choice-contexts/withdraw`);
    return exercise(P[org], T.alloc, a, "Allocation_Withdraw", { extraArgs: { context: c.choiceContextData, meta: { values: {} } } }, disclosedOf(c));
  },
  fund: (b, org) => { need(INSTRUMENT === "amulet", "treasury top-up is wired for Canton Coin only"); return fund(P[org], decimal(b.amount, MAX_FUND, "amount")); },
  grant: () => create(P.REGISTRY, T.deleg, { registry: P.REGISTRY, ops: P.OPS }),
  revoke: (b) => exercise(P.REGISTRY, T.deleg, cid(b.delegationCid), "Delegation_Revoke", {}),
};

// ---- auth: one password per organisation, a signed session cookie naming it, nothing stored server side
const ACCOUNTS = Object.fromEntries(ORGS.filter((o) => env[`PASSWORD_${o.key}`]).map((o) => [o.key, env[`PASSWORD_${o.key}`]]));
const SIGN_IN = (env.SESSION_SECRET ?? "").length >= 32 && Object.keys(ACCOUNTS).length > 0;
// One access code for the jury: signs in as any organisation and acts in its role, except switching the
// registry's automation on or off, which stays with the registry's own members.
const JUDGE_CODE = (env.JUDGE_CODE ?? "").length >= 8 ? env.JUDGE_CODE : null;
const MEMBERS_ONLY = new Set(["grant", "revoke"]);
const FUND_FLOOR = Number(env.FUND_FLOOR ?? 100);   // the treasury never goes below this through top-ups
const SESSION_MS = 8 * 3600e3;
const sign = (v) => createHmac("sha256", env.SESSION_SECRET).update(v).digest("base64url");
const same = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
// cookie: expiry.org.mode.id.mac, mode "member" (signed in) or "guest" (read-only, no password)
function session(req) {
  if (!SIGN_IN) return null;
  const m = /(?:^|;\s*)pg_session=(\d+)\.([A-Z_]+)\.(member|guest|judge)\.([\w-]+)\.([\w-]+)/.exec(req.headers.cookie ?? "");
  if (!m || !same(m[5], sign(`${m[1]}.${m[2]}.${m[3]}.${m[4]}`)) || Number(m[1]) < Date.now() || !P[m[2]]) return null;
  if (m[3] === "member" && !ACCOUNTS[m[2]]) return null;
  if (m[3] === "judge" && !JUDGE_CODE) return null;
  return { org: m[2], mode: m[3], guest: m[3] === "guest", id: m[4] };
}
const newSession = (org, mode, ms) => { const v = `${Date.now() + ms}.${org}.${mode}.${randomBytes(12).toString("base64url")}`; return cookie(`${v}.${sign(v)}`, ms / 1000); };
const cookie = (v, maxAge) => `pg_session=${v}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
// Caddy replaces any client-sent X-Forwarded-For (no trusted proxies), so its first entry is the client.
const clientIp = (req) => (req.headers["x-forwarded-for"] ?? "").split(",")[0].trim() || req.socket.remoteAddress;

// ponytail: in-memory counters, reset on restart; a shared store (Redis) once there is more than one instance
const hits = new Map();
function limited(key, max, windowMs) {
  const now = Date.now(), h = hits.get(key);
  if (!h || h.until < now) { hits.set(key, { n: 1, until: now + windowMs }); return false; }
  return ++h.n > max;
}
const blocked = (key, max) => { const h = hits.get(key); return Boolean(h && h.until >= Date.now() && h.n >= max); };

// Writes go one at a time: two draws in parallel would spend the same holdings.
let queue = Promise.resolve();
const serial = (fn) => { const run = queue.then(fn); queue = run.catch(() => {}); return run; };

// ---- reads: an organisation's own contracts, and the public visibility matrix (template counts only)
async function contractsOf(party) {
  const { offset } = await ledger("/v2/state/ledger-end", undefined, "GET");
  const rows = await ledger("/v2/state/active-contracts", { activeAtOffset: offset, verbose: false, eventFormat: { filtersByParty: wildcard(party), verbose: false } });
  const contracts = rows.map((r) => r.contractEntry?.JsActiveContract?.createdEvent).filter(Boolean)
    .map((c) => ({ t: c.templateId.split(":").pop(), a: c.createArgument ?? {}, cid: c.contractId }))
    // the test package's mock instrument is not part of this deployment
    .filter((c) => INSTRUMENT === "mock" || !c.t.startsWith("Mock"))
    .filter((c) => c.t !== "Holding" && (/^(CollateralFingerprint|FacilityProposal|Facility|DrawRequest|ClaimIndex|Claim|CollisionNotice|RegistryDelegation)$/.test(c.t) || /Allocation$/.test(c.t)))
    .map((c) => {
      const leg = c.a.allocation?.transferLeg; // a token-standard allocation nests its leg
      return leg ? { ...c, a: { amount: leg.amount, sender: leg.sender, receiver: leg.receiver } } : c;
    });
  return { offset, contracts };
}

let matrix = { at: 0, value: null };
async function visibility() {
  if (Date.now() - matrix.at < 10_000 && matrix.value) return matrix.value;
  const rows = await Promise.all(ORGS.map(async (o) => {
    const { contracts } = await contractsOf(o.party);
    const counts = {};
    for (const c of contracts) { const t = /Allocation$/.test(c.t) ? "Allocation" : c.t; counts[t] = (counts[t] ?? 0) + 1; }
    return { key: o.key, label: o.label, counts };
  }));
  matrix = { at: Date.now(), value: rows };
  return rows;
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
      return json(res, 200, {
        orgs: ORGS.map(({ key, label, blurb, party }) => ({ key, label, blurb, party })), signIn: SIGN_IN,
        network: "Canton DevNet", instrument: INSTRUMENT, unit: UNIT, maxDraw: MAX_DRAW, maxFund: MAX_FUND,
      });
    }
    if (url.pathname === "/visibility") return json(res, 200, await visibility());

    if (url.pathname === "/auth/me") { const s = session(req); return json(res, 200, { org: s?.org ?? null, guest: Boolean(s?.guest), mode: s?.mode ?? null }); }
    if (url.pathname.startsWith("/me/")) {
      const s = session(req);
      if (!s) return json(res, 401, { error: "sign in first" });
      if (url.pathname === "/me/contracts") return json(res, 200, await contractsOf(P[s.org]));
      if (url.pathname === "/me/balance") {
        const hs = ["ORIGINATOR", ...LENDERS].includes(s.org) ? await holdings(P[s.org]) : [];
        return json(res, 200, { balance: hs.reduce((n, h) => n + h.amount, 0) });
      }
      return json(res, 404, { error: "not found" });
    }

    if (url.pathname.startsWith("/auth/") || url.pathname.startsWith("/act/")) {
      if (req.method !== "POST") return json(res, 405, { error: "POST only" });
      if (!sameOrigin(req) || !String(req.headers["content-type"]).startsWith("application/json")) return json(res, 403, { error: "cross-origin or non-JSON request refused" });
      if (!SIGN_IN) return json(res, 403, { error: "sign-in is not configured" });

      if (url.pathname === "/auth/login") {
        // only failed attempts count: 10 per 15 minutes per address
        const key = `login:${clientIp(req)}`;
        if (blocked(key, 10)) return json(res, 429, { error: "too many failed attempts, wait 15 minutes" });
        const { org, password } = await readJson(req);
        const digest = (v) => createHash("sha256").update(String(v ?? "")).digest("base64url");
        const member = Object.hasOwn(ACCOUNTS, org) && same(digest(password), digest(ACCOUNTS[org]));
        const judge = !member && JUDGE_CODE && Object.hasOwn(P, org) && ORGS.some((o) => o.key === org) && same(digest(password), digest(JUDGE_CODE));
        if (!member && !judge) {
          limited(key, 10, 15 * 60e3);
          return json(res, 401, { error: "wrong organisation, password or access code" });
        }
        const mode = member ? "member" : "judge";
        return json(res, 200, { org, guest: false, mode }, { "set-cookie": newSession(org, mode, SESSION_MS) });
      }
      // Read-only look at one organisation's workspace, without an account: what a visitor or a judge needs.
      if (url.pathname === "/auth/guest") {
        if (limited(`guest:${clientIp(req)}`, 60, 15 * 60e3)) return json(res, 429, { error: "too many requests, wait a few minutes" });
        const { org } = await readJson(req);
        if (!Object.hasOwn(P, org) || !ORGS.some((o) => o.key === org)) return json(res, 400, { error: "unknown organisation" });
        return json(res, 200, { org, guest: true }, { "set-cookie": newSession(org, "guest", 3600e3) });
      }
      if (url.pathname === "/auth/logout") return json(res, 200, { org: null }, { "set-cookie": cookie("0.X.guest.x.x", 0) });

      const s = session(req);
      if (!s) return json(res, 401, { error: "sign in first" });
      const name = url.pathname.slice(5);
      if (!Object.hasOwn(ACTIONS, name)) return json(res, 404, { error: "unknown action" });
      if (s.guest) return json(res, 403, { error: "read-only access: sign in to act" });
      if (!ROLE[name].includes(s.org)) return json(res, 403, { error: "not an action of your organisation" });
      if (s.mode === "judge" && MEMBERS_ONLY.has(name)) return json(res, 403, { error: "reserved to the registry's members: the automation stays on for everyone" });
      if (limited(`actip:${clientIp(req)}`, 60, 60e3)) return json(res, 429, { error: "slow down: too many actions from this address" });
      if (limited(`act:${s.id}`, 30, 60e3)) return json(res, 429, { error: "slow down: 30 actions a minute" });
      const body = await readJson(req);
      const tx = await serial(() => ACTIONS[name](body, s.org));
      matrix.at = 0;
      return json(res, 200, { ok: true, updateId: tx.updateId, offset: tx.offset, created: tx.created });
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
    if (/^\/(act|auth|me)\//.test(url.pathname) || url.pathname === "/visibility") {
      return json(res, e.status ?? 500, { error: String(e.message ?? e) });
    }
    res.writeHead(e.code === "ENOENT" ? 404 : 500, { "content-type": "text/plain" });
    res.end(String(e.message ?? e));
  }
}).listen(PORT, () => {
  console.log(`PledgeGuard on http://localhost:${PORT}   site /   platform /app   (ledger ${LEDGER.replace(/^https:\/\//, "")})`);
  console.log(`sign-in ${SIGN_IN ? `for ${Object.keys(ACCOUNTS).join(", ")}, settling in ${UNIT}` : "not configured (SESSION_SECRET and PASSWORD_<ORG>)"}`);
  console.log(ORGS.map((o) => `  ${o.label.padEnd(18)} ${o.party}`).join("\n"));
});
