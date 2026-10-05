// Offline check of the registry automation against a fake JSON Ledger API. No ledger, no dependency.
//   node backend/registry.check.mjs     -> "registry check: ok", or an assertion error
// Asserts: a re-registered fingerprint for an already indexed hash gets no second index (the
// double-pledge bypass), two fingerprints for one new hash get one index even when the first index
// submit errors, and failed commands are retried.
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { deepStrictEqual } from "node:assert";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ev = (cid, t, a) => ({ contractEntry: { JsActiveContract: { createdEvent: { contractId: cid, templateId: `pkg:PledgeGuard.${t}`, createArgument: a } } } });
const acs = [
  ev("fpDup", "Registry:CollateralFingerprint", { hash: "H" }), // H already has an index below
  ev("fpNew", "Registry:CollateralFingerprint", { hash: "H2" }),
  ev("fpNew2", "Registry:CollateralFingerprint", { hash: "H2" }),
  ev("idxH", "Registry:ClaimIndex", { hash: "H" }),
  ev("drawB", "Lending:DrawRequest", { hash: "H", allocationCid: "allocB" }),
  ev("deleg", "Delegation:RegistryDelegation", {}),
];
const calls = [];
const ledger = createServer((req, res) => {
  let b = "";
  req.on("data", (c) => (b += c));
  req.on("end", () => {
    const send = (code, o) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (req.url === "/v2/state/ledger-end") return send(200, { offset: 10 });
    if (req.url === "/v2/state/active-contracts") return send(200, acs);
    if (req.url.startsWith("/v2/updates")) return setTimeout(() => send(200, []), 50);
    const c = JSON.parse(b).commands[0].ExerciseCommand;
    calls.push(`${c.choice}:${c.choiceArgument.fingerprintCid ?? c.choiceArgument.drawCid}`);
    // the first submit of each choice hits a transient error, the retry goes through
    send(calls.filter((x) => x.startsWith(c.choice)).length === 1 ? 503 : 200, {});
  });
}).listen(0, () => {
  const stateFile = join(tmpdir(), `pledgeguard-check-${process.pid}.json`);
  const bot = spawn(process.execPath, [new URL("./registry.mjs", import.meta.url).pathname], {
    stdio: "ignore",
    env: { ...process.env, LEDGER_URL: `http://127.0.0.1:${ledger.address().port}`, REGISTRY_PARTY: "reg", OPS_PARTY: "ops",
      AUDITOR_PARTY: "aud", POLL_MS: "50", STATE_FILE: stateFile },
  });
  setTimeout(() => {
    bot.kill();
    ledger.close();
    rmSync(stateFile, { force: true });
    deepStrictEqual(calls.filter((x) => x.startsWith("Delegation_Index")), ["Delegation_Index:fpNew", "Delegation_Index:fpNew"], "one index per hash, fpNew retried, fpNew2 never");
    deepStrictEqual(calls.filter((x) => x.startsWith("Delegation_Settle")), ["Delegation_Settle:drawB", "Delegation_Settle:drawB"], "settle retried once");
    console.log("registry check: ok");
  }, 1500);
});
