// PledgeGuard registry automation. Node 22, no dependencies.
// The registry is a decentralized (externally signed) party, so this process acts as the
// automation party `ops` through the RegistryDelegation contract the registry granted via
// governance, reading as the registry. It watches the registry's ACS delta and reacts:
//   CollateralFingerprint created  -> Delegation_Index
//   ClaimIndex created / archived  -> keep the hash -> latest ClaimIndex cid map
//   DrawRequest created            -> Delegation_Settle with the current index
// commandId is derived from the triggering contract id, so a restart never double-settles.
//
// Settling a real token-standard allocation needs the token registry's choice context, which
// is off-ledger: TOKEN_REGISTRY_URL is the registry base URL (Amulet on DevNet: the scan API).
// Without it the choice context is empty, which is what the mock allocation in the tests expects.
//
// env: LEDGER_URL, TOKEN (JWT, optional on LocalNet), USER_ID (needs CanActAs ops and
//      CanReadAs registry), OPS_PARTY, REGISTRY_PARTY, AUDITOR_PARTY, TOKEN_REGISTRY_URL,
//      STATE_FILE (offset persistence, default ./registry-state.json), POLL_MS (default 1000)

import { readFileSync, writeFileSync } from "node:fs";

const env = (k, d) => process.env[k] ?? d ?? (() => { throw new Error(`missing env ${k}`); })();
const LEDGER_URL = env("LEDGER_URL", "http://localhost:7575").replace(/\/$/, "");
const TOKEN = process.env.TOKEN;
const USER_ID = env("USER_ID", "ledger-api-user");
const REGISTRY = env("REGISTRY_PARTY");
const OPS = env("OPS_PARTY");
const AUDITOR = env("AUDITOR_PARTY");
const STATE_FILE = env("STATE_FILE", "./registry-state.json");
const POLL_MS = Number(env("POLL_MS", "1000"));
const REGISTRY_URL = (process.env.TOKEN_REGISTRY_URL ?? "").replace(/\/$/, "");
// Several versions of the app package can be vetted at once; pin the one this build expects,
// otherwise the ledger resolves #pledgeguard to an older version and rejects new choice fields.
const PKG_PREF = (process.env.PACKAGE_PREFERENCE ?? "").split(",").filter(Boolean);

const PKG = "#pledgeguard";
const T = {
  fingerprint: `${PKG}:PledgeGuard.Registry:CollateralFingerprint`,
  index: `${PKG}:PledgeGuard.Registry:ClaimIndex`,
  draw: `${PKG}:PledgeGuard.Lending:DrawRequest`,
  delegation: `${PKG}:PledgeGuard.Delegation:RegistryDelegation`,
};

async function api(path, body, method = "POST") {
  const res = await fetch(LEDGER_URL + path, {
    method,
    headers: { "content-type": "application/json", ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : undefined;
}

const tmpl = (templateId) => ({ identifierFilter: { TemplateFilter: { value: { templateId, includeCreatedEventBlob: false } } } });
const eventFormat = {
  filtersByParty: {
    [REGISTRY]: { cumulative: [T.fingerprint, T.index, T.draw].map(tmpl) },
    [OPS]: { cumulative: [T.delegation].map(tmpl) },
  },
  verbose: false,
};

// The registry publishes, per allocation, the context and reference contracts needed to execute
// the transfer. Returns the empty context when no registry is configured (mock allocations).
async function executeTransferContext(allocationCid) {
  if (!REGISTRY_URL) return { context: { values: {} }, disclosed: [] };
  const res = await fetch(`${REGISTRY_URL}/registry/allocations/v1/${encodeURIComponent(allocationCid)}/choice-contexts/execute-transfer`, {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  });
  if (!res.ok) throw new Error(`registry context ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const c = await res.json();
  return {
    context: c.choiceContextData ?? { values: {} },
    // the ledger rejects unknown fields, so keep only what a DisclosedContract carries
    disclosed: (c.disclosedContracts ?? []).map(({ templateId, contractId, createdEventBlob, synchronizerId }) =>
      ({ templateId, contractId, createdEventBlob, synchronizerId })),
  };
}

async function exercise(templateId, contractId, choice, choiceArgument, commandId, disclosedContracts = []) {
  try {
    await api("/v2/commands/submit-and-wait", {
      commands: [{ ExerciseCommand: { templateId, contractId, choice, choiceArgument } }],
      commandId,
      actAs: [OPS],
      readAs: [REGISTRY],
      userId: USER_ID,
      disclosedContracts,
      packageIdSelectionPreference: PKG_PREF,
    });
    console.log(`${choice} ok (${commandId})`);
  } catch (e) {
    // ALREADY_EXISTS = duplicate commandId after a restart, the work is already done.
    // CONTRACT_NOT_ACTIVE = someone raced us (e.g. lender withdrew). Anything else is worth seeing.
    const msg = String(e.message);
    // Never let one bad contract stop the automation: log it and keep serving the others.
    // Stale contracts from an older package version end up here after an upgrade.
    console.log(`${choice} failed on ${contractId.slice(0, 12)}: ${msg.slice(0, 200)}`);
  }
}

// hash -> latest ClaimIndex contract id (the registry is its only signatory, so this is authoritative)
const indexByHash = new Map();
const pendingDraws = [];
const pendingFingerprints = [];
let delegationCid = null; // the live RegistryDelegation granted to OPS, null once revoked

function onCreated(ev) {
  const a = ev.createArgument;
  if (ev.templateId.endsWith(":RegistryDelegation")) {
    delegationCid = ev.contractId;
    console.log(`delegation active: ${delegationCid}`);
    return;
  }
  if (ev.templateId.endsWith(":CollateralFingerprint")) pendingFingerprints.push(ev);
  if (ev.templateId.endsWith(":ClaimIndex")) {
    indexByHash.set(a.hash, ev.contractId);
    return;
  }
  if (ev.templateId.endsWith(":DrawRequest")) pendingDraws.push(ev);
}

async function settlePending() {
  if (!delegationCid) { if (pendingDraws.length || pendingFingerprints.length) console.log("waiting for a delegation from the registry"); return; }
  for (const ev of pendingFingerprints.splice(0)) {
    await exercise(T.delegation, delegationCid, "Delegation_Index", { fingerprintCid: ev.contractId }, `index-${ev.contractId}`);
  }
  for (const ev of pendingDraws.splice(0)) {
    const indexCid = indexByHash.get(ev.createArgument.hash);
    if (!indexCid) { console.log(`no index yet for ${ev.createArgument.hash}, retrying later`); pendingDraws.push(ev); continue; }
    const { context, disclosed } = await executeTransferContext(ev.createArgument.allocationCid);
    await exercise(T.delegation, delegationCid, "Delegation_Settle",
      { drawCid: ev.contractId, indexCid, auditor: AUDITOR, extraArgs: REGISTRY_URL ? { context, meta: { values: {} } } : null },
      `settle-${ev.contractId}`, disclosed);
  }
}

function loadState() { try { return JSON.parse(readFileSync(STATE_FILE, "utf8")); } catch { return { offset: null }; } }
function saveState(s) { writeFileSync(STATE_FILE, JSON.stringify(s)); }

async function bootstrap() {
  const { offset } = await api("/v2/state/ledger-end", undefined, "GET");
  const acs = await api("/v2/state/active-contracts", { eventFormat, activeAtOffset: offset, verbose: false });
  // delegation first, so fingerprints and draws found in the ACS can be acted on
  const events = acs.map((e) => e.contractEntry?.JsActiveContract?.createdEvent).filter(Boolean)
    .sort((a, b) => (b.templateId.endsWith(":RegistryDelegation") ? 1 : 0) - (a.templateId.endsWith(":RegistryDelegation") ? 1 : 0));
  for (const c of events) await onCreated(c);
  await settlePending();
  return offset;
}

async function main() {
  const state = loadState();
  // ponytail: on restart we rebuild the index map from the ACS and resume from the saved offset.
  // Duplicate reactions are harmless thanks to deterministic commandIds.
  let offset = await bootstrap();
  if (state.offset !== null && state.offset < offset) offset = state.offset;
  console.log(`registry ${REGISTRY} listening from offset ${offset}`);
  for (;;) {
    const updates = await api(`/v2/updates?limit=200&stream_idle_timeout_ms=${POLL_MS}`, {
      beginExclusive: offset,
      updateFormat: { includeTransactions: { eventFormat, transactionShape: "TRANSACTION_SHAPE_ACS_DELTA" } },
    });
    for (const u of updates ?? []) {
      const tx = u.update?.Transaction?.value;
      if (!tx) { offset = Math.max(offset, u.update?.OffsetCheckpoint?.value?.offset ?? offset); continue; }
      for (const e of tx.events) {
        if (e.CreatedEvent) await onCreated(e.CreatedEvent);
        if (e.ArchivedEvent?.templateId.endsWith(":ClaimIndex")) {
          for (const [h, cid] of indexByHash) if (cid === e.ArchivedEvent.contractId) indexByHash.delete(h);
        }
        if (e.ArchivedEvent?.contractId === delegationCid) { delegationCid = null; console.log("delegation revoked by the registry, standing by"); }
      }
      offset = tx.offset;
    }
    await settlePending();
    saveState({ offset });
    if (!updates?.length) await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
