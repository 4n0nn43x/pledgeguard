#!/bin/bash
# PledgeGuard on the DecMan LocalNet sandbox (three Canton participants, one synchronizer).
#
# Prerequisites, run once from a clone of DLC-link/decentralization-manager, branch hackathon:
#   ./hackathon/up.sh
#   PARTY_PREFIX=pledgeguard-registry ./hackathon/seed.sh   # registry = decentralized party, 2 of 3
#
# Then, from this repo:
#   ./demo/localnet.sh setup     # upload DARs to the 3 participants, allocate the app parties
#   ./demo/localnet.sh govern grant           # 2-of-3 vote: registry delegates routine work to ops
#   ./demo/localnet.sh govern-fail            # negative case: one confirmation, execute is refused
#   ./demo/localnet.sh backend   # run the registry automation (keep it running in a terminal)
#   ./demo/localnet.sh scenario  # fingerprint, two facilities, draw A, draw B collides, release, retry
#   ./demo/localnet.sh acs       # print what each party's participant returns (the privacy matrix)
#   ./demo/localnet.sh govern force-release <indexCid> "<reason>"   # disputed hash, members decide
#   ./demo/localnet.sh govern revoke "<reason>"                     # cut ops off, settlements stop
#
# Party placement: originator + lender A on participant 1, lender B on participant 2, auditor on
# participant 3, registry on all three (that is the decentralized party).
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
DECMAN=${DECMAN:-$HERE/../../../decman}
STATE=$HERE/.state
TOKEN=$(grep '^LOCALNET_CANTON_TOKEN=' "$DECMAN/hackathon/localnet.sh" | cut -d'"' -f2)
P1=3975; P2=2975; P3=4975
USER=ledger-api-user

api() { # port method path [json]
  local port=$1 method=$2 path=$3 data=${4-}
  curl -sS --fail-with-body -X "$method" "http://localhost:$port$path" \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' ${data:+-d "$data"}
}
submit() { # port actAs json-commands-array
  api "$1" POST /v2/commands/submit-and-wait-for-transaction "$(jq -n --arg p "$2" --argjson cmds "$3" --arg cid "pg-$RANDOM$RANDOM" \
    '{commands: {commands: $cmds, commandId: $cid, actAs: [$p], userId: "ledger-api-user"},
      transactionFormat: {transactionShape: "TRANSACTION_SHAPE_LEDGER_EFFECTS",
        eventFormat: {filtersByParty: {($p): {cumulative: [{identifierFilter: {WildcardFilter: {value: {includeCreatedEventBlob: false}}}}]}}, verbose: false}}}')"
}
created() { jq -r --arg t "$1" '.transaction.events[] | .CreatedEvent? // empty | select(.templateId | endswith($t)) | .contractId' | head -1; }
create() { submit "$1" "$2" "$(jq -n --arg t "$3" --argjson a "$4" '[{CreateCommand: {templateId: $t, createArguments: $a}}]')"; }
exercise() { submit "$1" "$2" "$(jq -n --arg t "$3" --arg c "$4" --arg ch "$5" --argjson a "$6" '[{ExerciseCommand: {templateId: $t, contractId: $c, choice: $ch, choiceArgument: $a}}]')"; }

load() { [ -f "$STATE" ] && . "$STATE" || true; }
save() { printf '%s=%q\n' "$1" "$2" >> "$STATE"; eval "$1=\$2"; }

alloc_party() { # port hint
  local p
  p=$(api "$1" POST /v2/parties "$(jq -n --arg h "$2" '{partyIdHint: $h, localMetadata: {annotations: {}}}')" | jq -r '.partyDetails.party')
  api "$1" POST /v2/users/$USER/rights "$(jq -n --arg p "$p" '{userId: "ledger-api-user", identityProviderId: "", rights: [{kind: {CanActAs: {value: {party: $p}}}}, {kind: {CanReadAs: {value: {party: $p}}}}]}')" >/dev/null
  echo "$p"
}

setup() {
  load
  REGISTRY=$(grep '^DEC_PARTY_ID=' "$DECMAN/hackathon/.state" | cut -d= -f2- | tr -d '"')
  [ -n "$REGISTRY" ] || { echo "run seed.sh first"; exit 1; }
  save REGISTRY "$REGISTRY"
  for dar in "$HERE"/../daml/pledgeguard/.daml/dist/pledgeguard-0.2.0.dar \
             "$HERE"/../daml/pledgeguard-test/.daml/dist/pledgeguard-test-0.2.0.dar \
             "$HERE"/../daml/pledgeguard-governance/.daml/dist/pledgeguard-governance-v1-0.1.0.dar; do
    for port in $P1 $P2 $P3; do
      curl -sS --fail-with-body -X POST "http://localhost:$port/v2/packages?vetAllPackages=true" \
        -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/octet-stream' --data-binary "@$dar" >/dev/null
    done
    echo "uploaded $(basename "$dar") to 3 participants"
  done
  [ -n "${ORIGINATOR-}" ] || save ORIGINATOR "$(alloc_party $P1 originator)"
  [ -n "${LENDER_A-}" ]   || save LENDER_A   "$(alloc_party $P1 lenderA)"
  [ -n "${LENDER_B-}" ]   || save LENDER_B   "$(alloc_party $P2 lenderB)"
  [ -n "${AUDITOR-}" ]    || save AUDITOR    "$(alloc_party $P3 auditor)"
  [ -n "${OPS-}" ]        || save OPS        "$(alloc_party $P1 registry-ops)"
  cat "$STATE"
}

backend() {
  load
  LEDGER_URL=http://localhost:$P1 TOKEN=$TOKEN USER_ID=$USER OPS_PARTY=$OPS REGISTRY_PARTY=$REGISTRY AUDITOR_PARTY=$AUDITOR \
    STATE_FILE=$HERE/.registry-state.json exec node "$HERE/../backend/registry.mjs"
}

# sha256 over the normalised identifying fields of the collateral pack (demo sample, run-salted so the
# scenario can be replayed on the same ledger)
HASH=${HASH:-$(printf 'receivables-pool-v1|contract=RP-2026-0917|debtor=Acme Auto Finance|nominal=1250000|origination=2026-09-01|run=%s' "$(date +%s)" | sha256sum | cut -c1-64)}
SCHEMA=receivables-pool-v1
T_FP='#pledgeguard:PledgeGuard.Registry:CollateralFingerprint'
T_PROP='#pledgeguard:PledgeGuard.Lending:FacilityProposal'
T_FAC='#pledgeguard:PledgeGuard.Lending:Facility'
T_CLAIM='#pledgeguard:PledgeGuard.Registry:Claim'
T_MOCK='#pledgeguard-test:PledgeGuard.Test.Scenario:MockAllocation'

facility() { # port lender amount rate -> facility cid
  local prop
  prop=$(create "$1" "$2" "$T_PROP" "$(jq -n --arg l "$2" --arg o "$ORIGINATOR" --arg r "$REGISTRY" --arg s "$SCHEMA" --arg h "$HASH" --arg a "$3" --arg rt "$4" \
    '{lender: $l, originator: $o, registry: $r, schemaId: $s, hash: $h, amount: $a, rate: $rt, maturity: "2027-04-01T00:00:00Z"}')" | created FacilityProposal)
  exercise $P1 "$ORIGINATOR" "$T_PROP" "$prop" FacilityProposal_Accept '{}' | created Facility
}
draw() { # port lender facility amount -> draw request cid
  local alloc
  alloc=$(create "$1" "$2" "$T_MOCK" "$(jq -n --arg e "$REGISTRY" --arg s "$2" --arg r "$ORIGINATOR" --arg a "$4" '{executor: $e, sender: $s, receiver: $r, amount: $a}')" | created MockAllocation)
  exercise "$1" "$2" "$T_FAC" "$3" Facility_RequestDraw "$(jq -n --arg c "$alloc" '{allocationCid: $c}')" | created DrawRequest
}
wait_settled() { # port party draw-cid : wait until the registry archived the request
  for _ in $(seq 1 30); do
    if ! acs_of "$1" "$2" | jq -e --arg c "$3" 'map(select(.contractId == $c)) | length > 0' >/dev/null; then return 0; fi
    sleep 1
  done
  echo "draw $3 not settled after 30s, is the backend running?" >&2; return 1
}

scenario() {
  load
  echo "1. originator registers the fingerprint"
  create $P1 "$ORIGINATOR" "$T_FP" "$(jq -n --arg o "$ORIGINATOR" --arg r "$REGISTRY" --arg s "$SCHEMA" --arg h "$HASH" '{originator: $o, registry: $r, schemaId: $s, hash: $h}')" | created CollateralFingerprint
  sleep 3
  echo "2. two bilateral facilities on the same hash"
  FAC_A=$(facility $P1 "$LENDER_A" 1000000.0 0.085); echo "   facility A $FAC_A"
  FAC_B=$(facility $P2 "$LENDER_B" 750000.0 0.091);  echo "   facility B $FAC_B"
  echo "3. lender A draws"
  DRAW_A=$(draw $P1 "$LENDER_A" "$FAC_A" 1000000.0); wait_settled $P1 "$LENDER_A" "$DRAW_A"
  echo "4. lender B draws on the same hash: collision"
  DRAW_B=$(draw $P2 "$LENDER_B" "$FAC_B" 750000.0); wait_settled $P2 "$LENDER_B" "$DRAW_B"
  echo "5. lender A repays and releases"
  CLAIM_A=$(acs_of $P1 "$LENDER_A" | jq -r --arg h "$HASH" '.[] | select((.templateId | endswith(":Claim")) and .createArgument.hash == $h) | .contractId' | head -1)
  exercise $P1 "$LENDER_A" "$T_CLAIM" "$CLAIM_A" Claim_Release '{}' >/dev/null
  sleep 2
  echo "6. lender B retries: settles"
  DRAW_B2=$(draw $P2 "$LENDER_B" "$FAC_B" 750000.0); wait_settled $P2 "$LENDER_B" "$DRAW_B2"
  echo; echo "hash of this run: $HASH"
  HASH_FILTER=$HASH acs
}

# ---- DecMan governance: propose as member 1 (a plain Daml create), confirm on P1 and P2, execute on P3.
G_PKG='#pledgeguard-governance-v1:PledgeGuard.Governance.Proposals'
PLACEHOLDER='{"type": "governance_set_threshold", "new_threshold": 0}'
dm() { curl -sS --fail-with-body -X "$1" "http://localhost:$2$3" -H 'Content-Type: application/json' ${4:+-d "$4"}; }
rules_cid() { dm GET 8081 "/governance/state?party_id=$REGISTRY" | jq -r '.state.contract_id'; }
proposal_status() { dm GET "$1" "/governance/confirmations?party_id=$REGISTRY" | jq -c --arg c "$2" 'first(.domain_actions[]? | select(.proposal_cid == $c)) // empty'; }
wait_seen() { for _ in $(seq 1 30); do [ -n "$(proposal_status "$1" "$2")" ] && return 0; sleep 2; done; echo "P$1 never saw $2" >&2; return 1; }
confirm() { dm POST "$1" /governance/confirm "$(jq -n --arg p "$REGISTRY" --arg r "$2" --arg c "$3" --argjson a "$PLACEHOLDER" '{party_id: $p, rules_contract_id: $r, action: $a, governance_type: "core_domain", proposal_cid: $c}')" >/dev/null; }
execute() { # port rules proposal -> exits non-zero if DecMan or the ledger refuses
  local confs
  confs=$(proposal_status "$1" "$3" | jq -c '[.confirmations[]?.contract_id]')
  dm POST "$1" /governance/execute "$(jq -n --arg p "$REGISTRY" --arg r "$2" --arg c "$3" --argjson a "$PLACEHOLDER" --argjson k "$confs" '{party_id: $p, rules_contract_id: $r, action: $a, confirmation_cids: $k, disclosed_contracts: [], governance_type: "core_domain", proposal_cid: $c}')"
}
propose() { # template args-json -> proposal cid (created on P1 as member party 1, the proposer)
  MEMBER_1=$(grep '^MEMBER_1=' "$DECMAN/hackathon/.state" | cut -d= -f2-)
  create $P1 "$MEMBER_1" "$G_PKG:$1" "$(jq -n --arg g "$REGISTRY" --arg m "$MEMBER_1" --argjson x "$2" '{governanceParty: $g, proposer: $m} + $x')" | created "$1"
}
govern() { # grant | revoke <reason> | force-release <indexCid> <reason>
  load
  local rules cid
  rules=$(rules_cid)
  case "$1" in
    grant) cid=$(propose GrantDelegationProposal "$(jq -n --arg o "$OPS" '{ops: $o}')") ;;
    revoke) local d; d=$(acs_of $P1 "$OPS" | jq -r '.[] | select(.templateId | endswith(":RegistryDelegation")) | .contractId' | head -1)
            cid=$(propose RevokeDelegationProposal "$(jq -n --arg d "$d" --arg r "${2:-operator decision}" '{delegationCid: $d, reason: $r}')") ;;
    force-release) cid=$(propose ClaimForceReleaseProposal "$(jq -n --arg i "$2" --arg r "${3:-dispute}" '{indexCid: $i, reason: $r}')") ;;
    *) echo "govern grant | revoke <reason> | force-release <indexCid> <reason>"; exit 1 ;;
  esac
  echo "proposal $cid"
  wait_seen 8081 "$cid"; confirm 8081 "$rules" "$cid"; echo "P1 confirmed (1 of 3)"
  wait_seen 8082 "$cid"; confirm 8082 "$rules" "$cid"; echo "P2 confirmed (2 of 3, threshold met)"
  for _ in $(seq 1 30); do proposal_status 8083 "$cid" | jq -e '.can_execute' >/dev/null 2>&1 && break; sleep 2; done
  execute 8083 "$rules" "$cid" >/dev/null; echo "P3 executed with the registry's authority"
}
govern_fail() { # the same proposal with a single confirmation: DecMan and the ledger refuse to execute
  load
  local rules cid
  rules=$(rules_cid)
  cid=$(propose GrantDelegationProposal "$(jq -n --arg o "$OPS" '{ops: $o}')")
  echo "proposal $cid"
  wait_seen 8081 "$cid"; confirm 8081 "$rules" "$cid"; echo "P1 confirmed (1 of 3)"
  wait_seen 8083 "$cid"
  if execute 8083 "$rules" "$cid" 2>&1 | grep -q .; then echo "execute below threshold was refused, as it must be"; fi
  proposal_status 8083 "$cid" | jq '{can_execute, confirmations: (.confirmations | length)}'
}

acs_of() { # port party -> [createdEvent]
  local off
  off=$(api "$1" GET /v2/state/ledger-end | jq '.offset')
  api "$1" POST /v2/state/active-contracts "$(jq -n --arg p "$2" --argjson o "$off" \
    '{activeAtOffset: $o, verbose: false, eventFormat: {filtersByParty: {($p): {cumulative: [{identifierFilter: {WildcardFilter: {value: {includeCreatedEventBlob: false}}}}]}}, verbose: false}}')" \
    | jq '[.[] | .contractEntry.JsActiveContract.createdEvent? // empty | select(.templateId | contains("PledgeGuard"))]'
}
acs() {
  load
  for row in "originator $P1 $ORIGINATOR" "lenderA $P1 $LENDER_A" "lenderB $P2 $LENDER_B" "registry $P1 $REGISTRY" "auditor $P3 $AUDITOR"; do
    set -- $row
    echo "== $1 (participant port $2)"
    acs_of "$2" "$3" | jq -r --arg h "${HASH_FILTER-}" '.[] | select($h == "" or ((.createArgument | tostring) | contains($h)) or (.templateId | endswith("Delegation"))) | "  " + (.templateId | split(":") | .[-1]) + "  " + (.createArgument | del(.registry, .originator, .auditor, .indexCid) | tostring | .[0:150])'
  done
}

case "${1-}" in setup|backend|scenario|acs) "$1" ;; govern) shift; govern "$@" ;; govern-fail) govern_fail ;; *) sed -n 2,16p "$0"; exit 1 ;; esac
