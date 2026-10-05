#!/bin/bash
# PledgeGuard on the shared HackCanton DevNet node (NODERS).
#
# One-time, by hand (nothing here can do it for you):
#   1. Open the wallet, log in with your HackCanton account, click "Onboard yourself",
#      then Transactions > Amount + TAP to get some CC.
#      https://wallet.validator.hackcanton-01.devnet.naas.noders.services
#   2. Open the Console, sign in with AuthFactory, Participants > HackCanton node > Parties,
#      and create four parties: originator, lenderA, lenderB, auditor, registry-ops.
#      (On DevNet the registry is a single party, not a decentralized one: the shared node
#      cannot host a 2-of-3 party. The decentralized registry is demonstrated on LocalNet,
#      see scripts/localnet.sh.) https://console.participant.hackcanton-01.devnet.naas.noders.services
#   3. Console > Collections > Upload DAR, for pledgeguard-0.2.0.dar and pledgeguard-test-0.2.0.dar.
#   4. Write scripts/.devnet.env (gitignored, never committed):
#        DEVNET_EMAIL=you@example.com
#        DEVNET_PASSWORD=...
#        REGISTRY=<party id you use as the registry>
#        OPS=<party id>
#        ORIGINATOR=<party id>
#        LENDER_A=<party id>
#        LENDER_B=<party id>
#        AUDITOR=<party id>
#
# Then:
#   ./scripts/devnet.sh whoami     # token, user id, rights: checks the setup
#   ./scripts/devnet.sh parties    # list the parties your user can act as
#   ./scripts/devnet.sh delegate   # create the RegistryDelegation (single-party registry on DevNet)
#   ./scripts/devnet.sh backend    # registry automation against DevNet
#   ./scripts/devnet.sh scenario   # fingerprint, two facilities, draw, collision, release, retry
#   ./scripts/devnet.sh acs        # per-party ACS, the privacy matrix, with the ledger offset
#   ./scripts/devnet.sh fund <PARTY> <AMOUNT>   # send the instrument from the wallet party to a demo party
#   ./scripts/devnet.sh holdings <PARTY>        # what that party holds of the instrument
#   ./scripts/devnet.sh txids      # collect update ids of this run, for the README
#
# AMULET=1 makes the draws real token-standard allocations of Canton Coin instead of the mock
# (fund the two lenders first). CBTC=1 does the same with cBTC, BitSafe's asset, whose own
# instrument admin is a Decentralized Party. Nothing in the Daml changes between the two.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
ENV_FILE=${ENV_FILE:-$HERE/.devnet.env}
[ -f "$ENV_FILE" ] || { sed -n 2,30p "$0"; exit 1; }
set -a; . "$ENV_FILE"; set +a

JSON_API=${JSON_API:-https://ledger-api-json.participant.hackcanton-01.devnet.naas.noders.services}
OIDC=${OIDC:-https://keycloak.naas.noders.services/realms/noders-appsfactory/protocol/openid-connect/token}
CLIENT_ID=${CLIENT_ID:-web-app-ui-hackcanton-01-devnet}
TOKEN_CACHE=$HERE/.devnet.token
# The instrument the draw settles in. Any CIP-56 registry works; two are wired here.
#   AMULET=1  Canton Coin, registry = the public DevNet scan
#   CBTC=1    cBTC (BitSafe), registry = the DA utility registrar for the cbtc-network party,
#             which is itself a Decentralized Party. Faucet: https://cbtc-faucet.bitsafe.finance/
AMULET=${AMULET:-}
CBTC=${CBTC:-}
CBTC_ADMIN=${CBTC_ADMIN:-cbtc-network::12202a83c6f4082217c175e29bc53da5f2703ba2675778ab99217a5a881a949203ff}
if [ -n "$CBTC" ]; then
  AMULET=1
  REGISTRY_URL=${REGISTRY_URL:-https://api.utilities.digitalasset-dev.com/api/token-standard/v0/registrars/$CBTC_ADMIN}
  INSTRUMENT_ADMIN=${INSTRUMENT_ADMIN:-$CBTC_ADMIN}
  INSTRUMENT_ID=${INSTRUMENT_ID:-CBTC}
else
  REGISTRY_URL=${REGISTRY_URL:-https://scan.sv-1.dev.global.canton.network.digitalasset.com}
  INSTRUMENT_ID=${INSTRUMENT_ID:-Amulet}
fi
# Pin the app package this checkout built: older versions may still be vetted on the shared node.
PKG_DAR=$HERE/../daml/pledgeguard/.daml/dist
PACKAGE_PREFERENCE=${PACKAGE_PREFERENCE:-$(ls "$PKG_DAR"/pledgeguard-*.dar 2>/dev/null | sort -V | tail -1 | xargs -r -I{} sh -c 'unzip -p "{}" META-INF/MANIFEST.MF | tr -d "\r\n " | grep -o "pledgeguard-[0-9.]*-[0-9a-f]\{64\}" | head -1 | sed "s/.*-//"')}
# Facility sizes. With AMULET=1 these are real Canton Coin, so keep them within what the lenders hold.
DRAW_A_AMOUNT=${DRAW_A_AMOUNT:-${AMULET:+120.0}}; DRAW_A_AMOUNT=${DRAW_A_AMOUNT:-1000000.0}
DRAW_B_AMOUNT=${DRAW_B_AMOUNT:-${AMULET:+90.0}}; DRAW_B_AMOUNT=${DRAW_B_AMOUNT:-750000.0}
I_HOLDING='#splice-api-token-holding-v1:Splice.Api.Token.HoldingV1:Holding'
T_TFACTORY='#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferFactory'
T_TINSTR='#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferInstruction'
T_AFACTORY='#splice-api-token-allocation-instruction-v1:Splice.Api.Token.AllocationInstructionV1:AllocationFactory'

token() { # cached while valid; the password never leaves this machine
  if [ -s "$TOKEN_CACHE" ] && [ "$(( $(date +%s) - $(stat -c %Y "$TOKEN_CACHE") ))" -lt 240 ]; then
    cat "$TOKEN_CACHE"; return
  fi
  curl -sS --fail-with-body "$OIDC" \
    -H 'Content-Type: application/x-www-form-urlencoded' \
    --data-urlencode 'grant_type=password' \
    --data-urlencode "client_id=$CLIENT_ID" \
    --data-urlencode "username=$DEVNET_EMAIL" \
    --data-urlencode "password=$DEVNET_PASSWORD" \
    --data-urlencode 'scope=openid daml_ledger_api offline_access' \
    | jq -r .access_token | tee "$TOKEN_CACHE"
  chmod 600 "$TOKEN_CACHE"
}
claim() { token | cut -d. -f2 | tr '_-' '/+' | base64 -d 2>/dev/null | jq -r ".$1"; }

api() { # method path [json]
  curl -sS --fail-with-body -X "$1" "$JSON_API$2" \
    -H "Authorization: Bearer $(token)" -H 'Content-Type: application/json' ${3:+-d "$3"}
}
submit() { # actAs json-commands-array [disclosed-contracts-json] -> transaction
  api POST /v2/commands/submit-and-wait-for-transaction "$(jq -n --arg p "$1" --argjson cmds "$2" \
    --argjson disc "${3:-[]}" \
    --arg cid "pg-$(date +%s)-$RANDOM" --arg u "$(claim sub)" \
    --arg pref "$PACKAGE_PREFERENCE" \
    '{commands: {commands: $cmds, commandId: $cid, actAs: [$p], userId: $u, disclosedContracts: $disc,
                 packageIdSelectionPreference: (if $pref == "" then [] else [$pref] end)},
      transactionFormat: {transactionShape: "TRANSACTION_SHAPE_LEDGER_EFFECTS",
        eventFormat: {filtersByParty: {($p): {cumulative: [{identifierFilter: {WildcardFilter: {value: {includeCreatedEventBlob: false}}}}]}}, verbose: false}}}')"
}
created() { jq -r --arg t "$1" '.transaction.events[] | .CreatedEvent? // empty | select(.templateId | endswith($t)) | .contractId' | head -1; }
create() { submit "$1" "$(jq -n --arg t "$2" --argjson a "$3" '[{CreateCommand: {templateId: $t, createArguments: $a}}]')"; }
exercise() { submit "$1" "$(jq -n --arg t "$2" --arg c "$3" --arg ch "$4" --argjson a "$5" '[{ExerciseCommand: {templateId: $t, contractId: $c, choice: $ch, choiceArgument: $a}}]')" "${6:-[]}"; }

# ---- Amulet, through the token standard. The registry serves the choice context and the
# reference contracts (AmuletRules, open rounds) that every choice needs; we pass them as
# disclosed contracts. Same interfaces any CIP-56 instrument implements.
WALLET=${WALLET:-}
wallet_party() { [ -n "$WALLET" ] || WALLET="$(claim sub)::${REGISTRY#*::}"; echo "$WALLET"; }
# The instrument admin: given for cBTC, read from the registry for Canton Coin.
dso() { [ -n "${INSTRUMENT_ADMIN-}" ] || INSTRUMENT_ADMIN=$(curl -sS "$REGISTRY_URL/registry/metadata/v1/info" | jq -r .adminId); echo "$INSTRUMENT_ADMIN"; }
reg_post() { curl -sS --fail-with-body -X POST "$REGISTRY_URL$1" -H 'content-type: application/json' -d "${2:-{\}}"; }
holdings_of() { # party -> [contractId]
  local off; off=$(api GET /v2/state/ledger-end | jq '.offset')
  api POST /v2/state/active-contracts "$(jq -n --arg p "$1" --argjson o "$off" --arg i "$I_HOLDING" \
    '{activeAtOffset: $o, verbose: false, eventFormat: {filtersByParty: {($p): {cumulative: [{identifierFilter: {InterfaceFilter: {value: {interfaceId: $i, includeInterfaceView: true, includeCreatedEventBlob: false}}}}]}}, verbose: false}}')" \
    | jq --arg iid "$INSTRUMENT_ID" '[.[] | .contractEntry.JsActiveContract.createdEvent | {cid: .contractId, amount: (.interfaceViews[0].viewValue.amount | tonumber), id: .interfaceViews[0].viewValue.instrumentId.id, locked: (.interfaceViews[0].viewValue.lock != null)} | select((.locked | not) and .id == $iid)]'
}
holdings_() { holdings_of "$1" | jq -r '.[] | "\(.amount)  \(.cid)"'; echo "total: $(holdings_of "$1" | jq '[.[].amount] | add // 0')"; }

fund_() { # party amount: token-standard transfer from the wallet party, accept if it stays pending
  local to=$1 amount=$2 from now later hs args factory ctx disc out instr
  from=$(wallet_party); now=$(date -u +%Y-%m-%dT%H:%M:%SZ); later=$(date -u -d '+24 hours' +%Y-%m-%dT%H:%M:%SZ)
  hs=$(holdings_of "$from" | jq '[.[].cid]')
  args=$(jq -n --arg a "$(dso)" --arg s "$from" --arg r "$to" --arg amt "$amount" --arg now "$now" --arg later "$later" --argjson hs "$hs" \
    --arg iid "$INSTRUMENT_ID" '{expectedAdmin: $a, transfer: {sender: $s, receiver: $r, amount: $amt, instrumentId: {admin: $a, id: $iid}, requestedAt: $now, executeBefore: $later, inputHoldingCids: $hs, meta: {values: {}}}, extraArgs: {context: {values: {}}, meta: {values: {}}}}')
  factory=$(reg_post /registry/transfer-instruction/v1/transfer-factory "$(jq -n --argjson c "$args" '{choiceArguments: $c}')")
  ctx=$(jq -c '.choiceContext.choiceContextData' <<<"$factory")
  disc=$(jq -c '[.choiceContext.disclosedContracts[] | {templateId, contractId, createdEventBlob, synchronizerId}]' <<<"$factory")
  out=$(exercise "$from" "$T_TFACTORY" "$(jq -r .factoryId <<<"$factory")" TransferFactory_Transfer \
    "$(jq -n --argjson a "$args" --argjson ctx "$ctx" '$a * {extraArgs: {context: $ctx, meta: {values: {}}}}')" "$disc")
  instr=$(jq -r '[.transaction.events[] | .CreatedEvent? // empty | select(.templateId | contains("TransferInstruction") or contains("AmuletTransferInstruction")) | .contractId] | first // empty' <<<"$out")
  if [ -n "$instr" ]; then
    echo "   transfer pending, $to accepts instruction $instr"
    ctx=$(reg_post "/registry/transfer-instruction/v1/$instr/choice-contexts/accept")
    exercise "$to" "$T_TINSTR" "$instr" TransferInstruction_Accept \
      "$(jq -n --argjson c "$(jq -c .choiceContextData <<<"$ctx")" '{extraArgs: {context: $c, meta: {values: {}}}}')" \
      "$(jq -c '[.disclosedContracts[] | {templateId, contractId, createdEventBlob, synchronizerId}]' <<<"$ctx")" >/dev/null
  fi
  echo "   $to now holds $(holdings_of "$to" | jq '[.[].amount] | add // 0') Amulet"
}

allocate() { # lender amount settlement-ref -> allocation cid (real Amulet allocation)
  local now later hs args factory ctx disc out
  now=$(date -u +%Y-%m-%dT%H:%M:%SZ); later=$(date -u -d '+24 hours' +%Y-%m-%dT%H:%M:%SZ)
  hs=$(holdings_of "$1" | jq '[.[].cid]')
  args=$(jq -n --arg a "$(dso)" --arg iid "$INSTRUMENT_ID" --arg s "$1" --arg r "$ORIGINATOR" --arg e "$REGISTRY" --arg amt "$2" --arg ref "$3" --arg now "$now" --arg later "$later" --argjson hs "$hs" \
    '{expectedAdmin: $a, allocation: {settlement: {executor: $e, settlementRef: {id: $ref, cid: null}, requestedAt: $now, allocateBefore: $later, settleBefore: $later, meta: {values: {}}}, transferLegId: "draw", transferLeg: {sender: $s, receiver: $r, amount: $amt, instrumentId: {admin: $a, id: $iid}, meta: {values: {}}}}, requestedAt: $now, inputHoldingCids: $hs, extraArgs: {context: {values: {}}, meta: {values: {}}}}')
  factory=$(reg_post /registry/allocation-instruction/v1/allocation-factory "$(jq -n --argjson c "$args" '{choiceArguments: $c}')")
  ctx=$(jq -c '.choiceContext.choiceContextData' <<<"$factory")
  disc=$(jq -c '[.choiceContext.disclosedContracts[] | {templateId, contractId, createdEventBlob, synchronizerId}]' <<<"$factory")
  out=$(exercise "$1" "$T_AFACTORY" "$(jq -r .factoryId <<<"$factory")" AllocationFactory_Allocate \
    "$(jq -n --argjson a "$args" --argjson ctx "$ctx" '$a * {extraArgs: {context: $ctx, meta: {values: {}}}}')" "$disc")
  jq -r '[.transaction.events[] | .CreatedEvent? // empty | select(.templateId | contains("AmuletAllocation") or endswith(":Allocation")) | .contractId] | first // empty' <<<"$out"
}

T_FP='#pledgeguard:PledgeGuard.Registry:CollateralFingerprint'
T_PROP='#pledgeguard:PledgeGuard.Lending:FacilityProposal'
T_FAC='#pledgeguard:PledgeGuard.Lending:Facility'
T_CLAIM='#pledgeguard:PledgeGuard.Registry:Claim'
T_DELEG='#pledgeguard:PledgeGuard.Delegation:RegistryDelegation'
T_MOCK='#pledgeguard-test:PledgeGuard.Test.Scenario:MockAllocation'
T_DRAWREQ='#pledgeguard:PledgeGuard.Lending:DrawRequest'
SCHEMA=receivables-pool-v1
HASH=${HASH:-$(printf 'receivables-pool-v1|contract=RP-2026-0917|debtor=Acme Auto Finance|nominal=1250000|origination=2026-09-01|run=%s' "$(date +%s)" | sha256sum | cut -c1-64)}

whoami_() {
  echo "user id (sub): $(claim sub)"
  echo "audience:      $(claim aud)"
  api GET /v2/version | jq -r '"ledger:        " + .version'
  api GET "/v2/users/$(claim sub)/rights" | jq -r '.rights[] | .kind | to_entries[0] | "\(.key)  \(.value.value.party // "-")"'
}
parties_() { api GET /v2/parties | jq -r '.partyDetails[] | .party'; }

delegate_() { # on DevNet the registry is a plain party we act as, so this is a direct create
  create "$REGISTRY" "$T_DELEG" "$(jq -n --arg r "$REGISTRY" --arg o "$OPS" '{registry: $r, ops: $o}')" | created RegistryDelegation
}

backend_() {
  LEDGER_URL=$JSON_API TOKEN=$(token) USER_ID=$(claim sub) OPS_PARTY=$OPS REGISTRY_PARTY=$REGISTRY \
    AUDITOR_PARTY=$AUDITOR TOKEN_REGISTRY_URL=${AMULET:+$REGISTRY_URL} \
    STATE_FILE=$HERE/.devnet-registry-state.json exec node "$HERE/../backend/registry.mjs"
}

facility() { # lender amount rate -> facility cid
  local prop
  prop=$(create "$1" "$T_PROP" "$(jq -n --arg l "$1" --arg o "$ORIGINATOR" --arg r "$REGISTRY" --arg s "$SCHEMA" --arg h "$HASH" --arg a "$2" --arg rt "$3" \
    '{lender: $l, originator: $o, registry: $r, schemaId: $s, hash: $h, amount: $a, rate: $rt, maturity: "2027-04-01T00:00:00Z"}')" | created FacilityProposal)
  exercise "$ORIGINATOR" "$T_PROP" "$prop" FacilityProposal_Accept '{}' | created Facility
}
draw() { # lender facility amount -> draw request cid
  local alloc
  if [ -n "$AMULET" ]; then
    alloc=$(allocate "$1" "$3" "$HASH")
    [ -n "$alloc" ] || { echo "allocation failed for $1" >&2; return 1; }
  else
    alloc=$(create "$1" "$T_MOCK" "$(jq -n --arg e "$REGISTRY" --arg s "$1" --arg r "$ORIGINATOR" --arg a "$3" '{executor: $e, sender: $s, receiver: $r, amount: $a}')" | created MockAllocation)
  fi
  exercise "$1" "$T_FAC" "$2" Facility_RequestDraw "$(jq -n --arg c "$alloc" '{allocationCid: $c}')" | created DrawRequest
}
wait_settled() { # party draw-cid
  for _ in $(seq 1 40); do
    acs_of "$1" | jq -e --arg c "$2" 'map(select(.contractId == $c)) | length == 0' >/dev/null && return 0
    sleep 1
  done
  echo "draw $2 not settled after 40s, is ./scripts/devnet.sh backend running?" >&2; return 1
}

scenario_() {
  echo "hash of this run: $HASH"
  echo "1. originator registers the fingerprint"
  create "$ORIGINATOR" "$T_FP" "$(jq -n --arg o "$ORIGINATOR" --arg r "$REGISTRY" --arg s "$SCHEMA" --arg h "$HASH" '{originator: $o, registry: $r, schemaId: $s, hash: $h}')" | created CollateralFingerprint
  sleep 4
  echo "2. two bilateral facilities on the same hash"
  FAC_A=$(facility "$LENDER_A" "$DRAW_A_AMOUNT" 0.085); echo "   facility A $FAC_A"
  FAC_B=$(facility "$LENDER_B" "$DRAW_B_AMOUNT" 0.091);  echo "   facility B $FAC_B"
  echo "3. lender A draws"
  DRAW_A=$(draw "$LENDER_A" "$FAC_A" "$DRAW_A_AMOUNT"); wait_settled "$LENDER_A" "$DRAW_A"
  echo "3b. originator registers the same fingerprint again (the fraud): no second index"
  create "$ORIGINATOR" "$T_FP" "$(jq -n --arg o "$ORIGINATOR" --arg r "$REGISTRY" --arg s "$SCHEMA" --arg h "$HASH" '{originator: $o, registry: $r, schemaId: $s, hash: $h}')" >/dev/null
  sleep 3
  echo "4. lender B draws on the same hash: collision"
  DRAW_B=$(draw "$LENDER_B" "$FAC_B" "$DRAW_B_AMOUNT"); wait_settled "$LENDER_B" "$DRAW_B"
  acs_of "$LENDER_B" | jq -e --arg h "$HASH" 'any(.[]; (.templateId | endswith(":CollisionNotice")) and .createArgument.hash == $h)' >/dev/null \
    || { echo "FAIL: lender B settled on a pledged hash, no collision notice" >&2; exit 1; }
  echo "   collision recorded, no transfer"
  echo "5. lender A repays and releases"
  CLAIM_A=$(acs_of "$LENDER_A" | jq -r --arg h "$HASH" '.[] | select((.templateId | endswith(":Claim")) and .createArgument.hash == $h) | .contractId' | head -1)
  exercise "$LENDER_A" "$T_CLAIM" "$CLAIM_A" Claim_Release '{}' >/dev/null
  sleep 3
  echo "6. lender B retries: settles"
  DRAW_B2=$(draw "$LENDER_B" "$FAC_B" "$DRAW_B_AMOUNT"); wait_settled "$LENDER_B" "$DRAW_B2"
  HASH_FILTER=$HASH acs_
}

acs_of() { # party -> [createdEvent]
  local off; off=$(api GET /v2/state/ledger-end | jq '.offset')
  api POST /v2/state/active-contracts "$(jq -n --arg p "$1" --argjson o "$off" \
    '{activeAtOffset: $o, verbose: false, eventFormat: {filtersByParty: {($p): {cumulative: [{identifierFilter: {WildcardFilter: {value: {includeCreatedEventBlob: false}}}}]}}, verbose: false}}')" \
    | jq '[.[] | .contractEntry.JsActiveContract.createdEvent? // empty | select(.templateId | contains("PledgeGuard"))]'
}
acs_() {
  echo "ledger offset: $(api GET /v2/state/ledger-end | jq '.offset')"
  for row in "originator $ORIGINATOR" "lenderA $LENDER_A" "lenderB $LENDER_B" "registry $REGISTRY" "auditor $AUDITOR"; do
    set -- $row
    echo "== $1"
    acs_of "$2" | jq -r --arg h "${HASH_FILTER-}" '.[] | select($h == "" or ((.createArgument | tostring) | contains($h)) or (.templateId | endswith("Delegation"))) | "  " + (.templateId | split(":") | .[-1]) + "  " + (.createArgument | del(.registry, .originator, .auditor, .indexCid) | tostring | .[0:140])'
  done
}
txids_() { # every update this user's parties saw, newest last: for the README evidence
  local off; off=$(api GET /v2/state/ledger-end | jq '.offset')
  api POST "/v2/updates?limit=200" "$(jq -n --arg p "$REGISTRY" --argjson e "$off" \
    '{beginExclusive: ($e - 400), endInclusive: $e, updateFormat: {includeTransactions: {transactionShape: "TRANSACTION_SHAPE_ACS_DELTA", eventFormat: {filtersByParty: {($p): {cumulative: [{identifierFilter: {WildcardFilter: {value: {includeCreatedEventBlob: false}}}}]}}, verbose: false}}}}')" \
    | jq -r '.[] | .update.Transaction.value? // empty | "offset \(.offset)  \(.updateId)  " + ([.events[] | (.CreatedEvent // .ArchivedEvent).templateId | split(":") | .[-1]] | join(","))'
}

case "${1-}" in
  whoami) whoami_ ;; parties) parties_ ;; delegate) delegate_ ;; backend) backend_ ;;
  scenario) scenario_ ;; acs) acs_ ;; txids) txids_ ;;
  token) token ;; fund) fund_ "$2" "$3" ;; holdings) holdings_ "$2" ;; wallet) wallet_party ;;
  *) sed -n 2,30p "$0"; exit 1 ;;
esac
