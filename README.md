# PledgeGuard

Privacy-preserving collateral collision registry on Canton Network.
HackCanton Season #3, track RWA & Business Workflows. Answer to [CIP #245](https://github.com/canton-foundation/cips/pull/245) open question 4.

**The problem.** The same collateral (a receivables pool, a loan pack) gets pledged to several lenders and nobody can tell: Tricolor cost JPMorgan a $170M charge-off, First Brands double-financed receivables into a ~$10B bankruptcy. On a transparent chain the collision is visible but so is every lender's book. On Canton the books are private, so the collision is invisible too.

**What PledgeGuard does.** A lender's stablecoin draw is released only after proving, in the same atomic transaction and without revealing its facility, that the collateral fingerprint is not already securing a live draw. The check is performed by a neutral **registry party** that sees hashes, not terms. The registry is a **Decentralized Party** created with BitSafe's [Decentralization Manager](https://github.com/DLC-link/decentralization-manager): hosted on three participants, 2-of-3 owner keys, no single operator.

**Status (24 Sep).** Runs end to end in two places. On the **DecMan LocalNet sandbox**: three Canton participants, the registry as a decentralized party, the delegation granted by a 2-of-3 governance vote, the negative case refused by the ledger (`scripts/localnet.sh`). On the **shared HackCanton DevNet node**: the same flow against the live network, Ledger API 3.5.18, evidence below (`scripts/devnet.sh`). The stablecoin leg is still a mock `Allocation`, same interface and controllers as Amulet.

### DevNet evidence, run of 24 Sep 2026

Node `hackcanton-devnet-3`, packages `pledgeguard 0.2.0` and `pledgeguard-test 0.2.0` vetted, six parties under the namespace `64bf737a-`. Collateral fingerprint of this run: `500fbc479a202cb52446a0575f41f387a32e89fd669124a7ef9ae47c8d03eb79`.

| Offset | Update id | What happened |
|---|---|---|
| 1049806 | `1220482e1751a195...6b1a2c5` | `RegistryDelegation` granted to the automation party |
| 1049859 | `12203b91cda795ce...d414412` | fingerprint registered, registry opens the `ClaimIndex` |
| 1049913 | `12205509cee329b9...8f2655fd` | **lender A draws**: index occupied, `Claim` created, transfer executed, one transaction |
| 1049937 | `12200ac0585d39a4...544513c1` | **lender B draws on the same hash**: no transfer, one `CollisionNotice` per lender |
| 1049946 | `12206d03a6a87c4f...10a0762` | lender A repays, `Claim_Release`, the hash is free |
| 1049970 | `12205454890ede8b...f5790ece` | lender B retries: settles |

Active contracts per party at offset 1049978, straight from each party's `/v2/state/active-contracts`:

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

1. Originator creates `CollateralFingerprint` = `sha256` over the normalised identifying fields of the collateral schema (`receivables-pool-v1`: contract number, debtor, nominal, origination date), never over a PDF. The registry opens one `ClaimIndex` per hash.
2. Lender and originator sign a bilateral `Facility` (propose / accept).
3. The lender allocates the stablecoin leg (token standard `Allocation`, sender = lender, receiver = originator, executor = registry) and exercises `Facility_RequestDraw`.
4. The registry exercises `DrawRequest_Settle`. Authority inside the choice is {lender, originator} (signatories) + {registry} (controller), exactly the three controllers of `Allocation_ExecuteTransfer`.
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
frontend/                 one window per party, "VIEWING AS" selector
scripts/localnet.sh       reproduce the whole thing on the DecMan LocalNet: setup, govern, backend, scenario, acs
scripts/devnet.sh         the same against the shared HackCanton DevNet node
```

## Run

```sh
# dpm 1.0.22: https://github.com/digital-asset/dpm/releases
./daml/build.sh   # builds every DAR (SDK 3.5.8 + 3.4.11) and runs the scenario
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

## Known limits (v1)

- The draw leg on LocalNet is a mock `Allocation` (same interface and controllers as Amulet/USDCx); wiring a real Amulet allocation on DevNet is next.
- The registry sees draw amounts (see above). A two-phase clearance would hide them but is not atomic.
- A matching fingerprint proves the same file was presented twice; it does not catch a freshly fabricated file describing the same collateral (CIP #245 says the same).
- Repayment is off the contract in v1: the lender releases the claim once repaid.
