# PledgeGuard

Privacy-preserving collateral collision registry on Canton Network.
HackCanton Season #3, track RWA & Business Workflows. Answer to [CIP #245](https://github.com/canton-foundation/cips/pull/245) open question 4.

**The problem.** The same collateral (a receivables pool, a loan pack) gets pledged to several lenders and nobody can tell: Tricolor cost JPMorgan a $170M charge-off, First Brands double-financed receivables into a ~$10B bankruptcy. On a transparent chain the collision is visible but so is every lender's book. On Canton the books are private, so the collision is invisible too.

**What PledgeGuard does.** A lender's stablecoin draw is released only after proving, in the same atomic transaction and without revealing its facility, that the collateral fingerprint is not already securing a live draw. The check is performed by a neutral **registry party** that sees hashes, not terms. The registry is a **Decentralized Party** created with BitSafe's [Decentralization Manager](https://github.com/DLC-link/decentralization-manager): hosted on three participants, 2-of-3 owner keys, no single operator.

**Status (5 Oct).** Runs end to end in two places. On the **DecMan LocalNet sandbox**: three Canton participants, the registry as a decentralized party, the delegation granted by a 2-of-3 governance vote, the negative case refused by the ledger (`scripts/localnet.sh`). On the **shared HackCanton DevNet node**: the same flow against the live network, settling **real Canton Coin** through the CIP-56 token standard, evidence below (`scripts/devnet.sh`). The runner can settle in **cBTC**, BitSafe's asset, with `CBTC=1` (the evidence below is Canton Coin): no Daml change, the check executes whatever CIP-56 allocation the lender created.

### DevNet evidence, run of 25 Sep 2026, real Canton Coin

Node `hackcanton-devnet-3`, Ledger API 3.5.18, package `pledgeguard 0.3.0` vetted, six parties
under the namespace `64bf737a-`. The draw leg is a **real CIP-56 allocation of Canton Coin**
(`AmuletAllocation`), created by the lender through the Amulet registry's
`AllocationFactory_Allocate` and executed by PledgeGuard's registry inside the collision check.
Fingerprint of this run: `0020e22f1d7b5ec3ca5b0ccdb9ed0c1224638546b32eee4f38e3b9eedb36d32b`.

| Offset | Update id | What happened |
|---|---|---|
| 1168752 | `12204252f8d1d8db...a6458a4` | fingerprint registered, registry opens the `ClaimIndex` |
| 1168794 | `12203923cfd38d57...2cfae06` | lender A allocates 120 CC, executor = the registry |
| 1168810 | `12205c5d51c77d89...3ae1b44e` | **draw A settles**: index occupied, `Claim` created, the `AmuletAllocation` is executed. One transaction |
| 1168836 | `12200a26ada73333...c184a914` | **draw B on the same fingerprint**: no transfer, one `CollisionNotice` per lender. B's allocation is untouched |
| 1168842 | `122060d4fac2b510...148a29bd` | lender A repays, `Claim_Release`, the fingerprint is free |
| 1168872 | `1220e5d5d49735d1...752d6374` | lender B retries and settles |

Balances before and after, read from the `Holding` interface: lender A 300 to 180 CC, the
originator receives it. The collided draw moved nothing. Money only moves when the check passes.

Active contracts per party, straight from each party's `/v2/state/active-contracts`:

| Party | What it holds |
|---|---|
| originator | both facilities |
| lender A | its facility, its own collision notice |
| lender B | its facility, its own collision notice, the live `ClaimIndex` and `Claim` |
| registry | the delegation, both notices, the index, the claim, **no facility** |
| auditor | the two collision notices, nothing else |

## The leak sentence

Lender B must never see Lender A's facility (borrower, amount, rate, or even its existence). The registry must never see a facility. Yet before B's draw is released, B must learn that this fingerprint already secures a live draw. The auditor sees collisions and nothing else.

What the registry does see, honestly: the hash, the lender, the originator and the amount of the draw leg it executes (it is the token-standard `executor`, and a party that sees an action sees its consequences). It never sees the `Facility` (commitment, rate, maturity).

## Parties and contracts

| Contract | Originator | Lender A | Lender B | Registry | Auditor |
|---|---|---|---|---|---|
| `CollateralFingerprint` (schemaId, hash) | yes | no | no | yes | no |
| `Facility` A (amount, rate, maturity) | yes | yes | no | no | no |
| `Facility` B | yes | no | yes | no | no |
| `DrawRequest` A (hash, allocation cid) | yes | yes | no | yes | no |
| Allocation of draw A (amount) | yes | yes | no | yes (executor) | no |
| `ClaimIndex` (hash, holder) | no | while holder | no | yes | no |
| `Claim` A (hash, lender, date) | no | yes | no | yes | no |
| `CollisionNotice` for A | no | yes | no | yes | yes |
| `CollisionNotice` for B | no | no | yes | yes | yes |

This matrix is not a UI filter: it is what each party's participant returns from `/v2/state/active-contracts`, and it is asserted by `daml/pledgeguard-test` (`scenario`).

## Flow

1. Originator creates `CollateralFingerprint` = `sha256` over the normalised identifying fields of the collateral schema (`receivables-pool-v1`: contract number, debtor, nominal, origination date), never over a PDF. The registry opens one `ClaimIndex` per hash; a second fingerprint for a hash that is already indexed is ignored, so a borrower who re-registers a pledged file still collides (step 3b of both scenario scripts re-registers the hash, step 4 asserts the collision; `backend/registry.check.mjs` checks it offline).
2. Lender and originator sign a bilateral `Facility` (propose / accept).
3. The lender allocates the stablecoin leg through the instrument's own registry (for Canton Coin:
   `AllocationFactory_Allocate` with the choice context the Amulet registry serves over HTTP),
   sender = lender, receiver = originator, executor = the PledgeGuard registry. Then it exercises
   `Facility_RequestDraw`. Any CIP-56 instrument works the same way: USDCx, USD1, a tokenised deposit.
4. The registry exercises `DrawRequest_Settle`, passing the registry's execute-transfer choice
   context and its disclosed contracts. Authority inside the choice is {lender, originator}
   (signatories) + {registry} (controller), exactly the three controllers of `Allocation_ExecuteTransfer`.
   - Index free: `ClaimIndex_Occupy`, create `Claim`, execute the transfer. One transaction.
   - Index held: no transfer, one `CollisionNotice` per lender (neither learns who the other is), the auditor sees both. The transaction succeeds, so the evidence is on the ledger.
5. On repayment the holder exercises `Claim_Release`; the hash is free again.
6. A disputed hash can be force-released only through DecMan governance (`ClaimForceReleaseProposal`, threshold of registry members).

## Governed where it belongs, routine where it must be

The registry is externally signed (2 of 3 owner keys held by three DecMan nodes), so any transaction it authorises directly needs a multi-signature round. Routine settlement cannot wait for that. So the members vote once on a `GrantDelegationProposal` (custom `GovernableAction`), which creates a `RegistryDelegation` giving an automation party `ops` two delegated choices: `Delegation_Index` and `Delegation_Settle`. Inside them the authority is {registry, ops}, and the Daml checks are unchanged. `ops` can never settle without the delegation (asserted in the test), the members can revoke it at any time (`RevokeDelegationProposal`), and a disputed hash is only ever force-released by a vote (`ClaimForceReleaseProposal`).

Negative case, from the ledger itself when a single member tries to execute: `The requirement 'Enough confirmations to execute action' was not met`. The threshold lives in the Daml `GovernanceRules`, not in DecMan.

Honest scope: index admission is delegated in v1 (a rogue `ops` could open two indexes for one hash); moving `Delegation_Index` behind a vote is the next step. All three participants run in one Canton container on LocalNet, so "operator independence" is simulated, not proven.

## Why Canton and not the chain you already use

- Sub-transaction privacy gives each lender its own projection; the registry is a stakeholder of `DrawRequest` and `Claim`, never of `Facility`.
- Contract keys are absent in LF 2.2 and non-unique in 2.3, so cross-contract uniqueness can only come from a signatory registry party. CIP #245 asks who may hold that role and under what governance. Answer: a market utility whose party is decentralized.
- Settlement uses the CIP-56 token standard `Allocation` interface, so the draw works with Amulet, USDCx or any conforming instrument.

## Layout

```
daml/
  vendor/                 Splice token-standard API packages and DecMan governance-action-v1 (Apache-2.0)
  pledgeguard/            PledgeGuard.Registry, PledgeGuard.Lending (SDK 3.5.8, LF 2.2)
  pledgeguard-test/       Daml Script scenario with the privacy assertions, mock Allocation
  pledgeguard-governance/ ClaimForceReleaseProposal implementing DecMan GovernableAction (SDK 3.4.11 like DecMan)
backend/                  registry automation acting as `ops` (JSON Ledger API v2, no dependency)
frontend/                 one window per party, "VIEWING AS" selector, plus a 90-line server
                          that holds the token and proxies the JSON Ledger API
scripts/localnet.sh       reproduce the whole thing on the DecMan LocalNet: setup, govern, backend, scenario, acs
scripts/devnet.sh         the same against the shared HackCanton DevNet node
```

## Run

```sh
# dpm 1.0.22: https://github.com/digital-asset/dpm/releases
./daml/build.sh   # builds every DAR (SDK 3.5.8 + 3.4.11) and runs the scenario
node backend/registry.check.mjs   # registry automation against a fake ledger: one index per hash, retries
```

Expected: `scenario: ok`. The script covers happy path, collision, wrong index (`submitMustFail`), release, retry, and revocation.

### On LocalNet with the decentralized registry (about 20 minutes, Docker with 12 GB)

```sh
git clone -b hackathon https://github.com/DLC-link/decentralization-manager ../decman
(cd ../decman && ./hackathon/up.sh && PARTY_PREFIX=pledgeguard-registry ./hackathon/seed.sh)
./scripts/localnet.sh setup          # DARs to the 3 participants, app parties (lender B on participant 2, auditor on 3)
./scripts/localnet.sh govern grant   # 2-of-3 vote: the registry delegates routine work to ops
./scripts/localnet.sh backend &      # registry automation
./scripts/localnet.sh scenario       # fingerprint, facilities, draw, collision, release, retry, per-party ACS
./scripts/localnet.sh govern-fail    # one confirmation only: execute is refused by the ledger
```

If your host already uses port 5432, start the sandbox with `DB_PORT=5433 ./hackathon/up.sh`.

### The party views

```sh
node frontend/server.mjs     # http://localhost:8090, reads scripts/.devnet.env
```

One column per party, refreshed every 4 seconds, plus a "VIEWING AS" selector. Nothing is
filtered in the page: each column is one `/v2/state/active-contracts` call for that party and
shows whatever comes back. Select the auditor and the screen holds two collision notices and
nothing else.

Honest note: the demo drives all parties from one ledger user that has `CanActAs` on each of
them, because the shared DevNet node gives every team one user. The separation on screen is not
that user's permissions, it is Canton's projection: the query is per party, and a party that is
not a stakeholder of a contract never receives it. On LocalNet the same views run against three
different participants, which removes the doubt entirely.

## Known limits (v1)

- On LocalNet the draw leg is a mock `Allocation` (same interface and controllers as Amulet/USDCx). On DevNet it is a real Canton Coin or cBTC allocation.
- One index per hash is enforced by the registry automation, not by the Daml model (LF 2.2 has no contract keys). A rogue `ops` could still open a second index (see "Honest scope" above).
- The public demo URL is read-only: its proxy relays only `active-contracts` and `ledger-end`, because the demo token can act as every party.
- The registry sees draw amounts (see above). A two-phase clearance would hide them but is not atomic.
- A matching fingerprint proves the same file was presented twice; it does not catch a freshly fabricated file describing the same collateral (CIP #245 says the same).
- Repayment is off the contract in v1: the lender releases the claim once repaid.
