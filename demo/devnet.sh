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
#      see demo/localnet.sh.) https://console.participant.hackcanton-01.devnet.naas.noders.services
#   3. Console > Collections > Upload DAR, for pledgeguard-0.2.0.dar and pledgeguard-test-0.2.0.dar.
#   4. Write demo/.devnet.env (gitignored, never committed):
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
#   ./demo/devnet.sh whoami     # token, user id, rights: checks the setup
#   ./demo/devnet.sh parties    # list the parties your user can act as
#   ./demo/devnet.sh delegate   # create the RegistryDelegation (single-party registry on DevNet)
#   ./demo/devnet.sh backend    # registry automation against DevNet
#   ./demo/devnet.sh scenario   # fingerprint, two facilities, draw, collision, release, retry
#   ./demo/devnet.sh acs        # per-party ACS, the privacy matrix, with the ledger offset
#   ./demo/devnet.sh txids      # collect update ids of this run, for the README
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
ENV_FILE=${ENV_FILE:-$HERE/.devnet.env}
[ -f "$ENV_FILE" ] || { sed -n 2,30p "$0"; exit 1; }
set -a; . "$ENV_FILE"; set +a

JSON_API=${JSON_API:-https://ledger-api-json.participant.hackcanton-01.devnet.naas.noders.services}
OIDC=${OIDC:-https://keycloak.naas.noders.services/realms/noders-appsfactory/protocol/openid-connect/token}
CLIENT_ID=${CLIENT_ID:-web-app-ui-hackcanton-01-devnet}
TOKEN_CACHE=$HERE/.devnet.token

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
submit() { # actAs json-commands-array -> transaction
  api POST /v2/commands/submit-and-wait-for-transaction "$(jq -n --arg p "$1" --argjson cmds "$2" \
    --arg cid "pg-$(date +%s)-$RANDOM" --arg u "$(claim sub)" \
    '{commands: {commands: $cmds, commandId: $cid, actAs: [$p], userId: $u},
      transactionFormat: {transactionShape: "TRANSACTION_SHAPE_LEDGER_EFFECTS",
        eventFormat: {filtersByParty: {($p): {cumulative: [{identifierFilter: {WildcardFilter: {value: {includeCreatedEventBlob: false}}}}]}}, verbose: false}}}')"
}
created() { jq -r --arg t "$1" '.transaction.events[] | .CreatedEvent? // empty | select(.templateId | endswith($t)) | .contractId' | head -1; }
create() { submit "$1" "$(jq -n --arg t "$2" --argjson a "$3" '[{CreateCommand: {templateId: $t, createArguments: $a}}]')"; }
exercise() { submit "$1" "$(jq -n --arg t "$2" --arg c "$3" --arg ch "$4" --argjson a "$5" '[{ExerciseCommand: {templateId: $t, contractId: $c, choice: $ch, choiceArgument: $a}}]')"; }

T_FP='#pledgeguard:PledgeGuard.Registry:CollateralFingerprint'
T_PROP='#pledgeguard:PledgeGuard.Lending:FacilityProposal'
T_FAC='#pledgeguard:PledgeGuard.Lending:Facility'
T_CLAIM='#pledgeguard:PledgeGuard.Registry:Claim'
T_DELEG='#pledgeguard:PledgeGuard.Delegation:RegistryDelegation'
T_MOCK='#pledgeguard-test:PledgeGuard.Test.Scenario:MockAllocation'
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
    AUDITOR_PARTY=$AUDITOR STATE_FILE=$HERE/.devnet-registry-state.json exec node "$HERE/../backend/registry.mjs"
}

facility() { # lender amount rate -> facility cid
  local prop
  prop=$(create "$1" "$T_PROP" "$(jq -n --arg l "$1" --arg o "$ORIGINATOR" --arg r "$REGISTRY" --arg s "$SCHEMA" --arg h "$HASH" --arg a "$2" --arg rt "$3" \
    '{lender: $l, originator: $o, registry: $r, schemaId: $s, hash: $h, amount: $a, rate: $rt, maturity: "2027-04-01T00:00:00Z"}')" | created FacilityProposal)
  exercise "$ORIGINATOR" "$T_PROP" "$prop" FacilityProposal_Accept '{}' | created Facility
}
draw() { # lender facility amount -> draw request cid
  local alloc
  alloc=$(create "$1" "$T_MOCK" "$(jq -n --arg e "$REGISTRY" --arg s "$1" --arg r "$ORIGINATOR" --arg a "$3" '{executor: $e, sender: $s, receiver: $r, amount: $a}')" | created MockAllocation)
  exercise "$1" "$T_FAC" "$2" Facility_RequestDraw "$(jq -n --arg c "$alloc" '{allocationCid: $c}')" | created DrawRequest
}
wait_settled() { # party draw-cid
  for _ in $(seq 1 40); do
    acs_of "$1" | jq -e --arg c "$2" 'map(select(.contractId == $c)) | length == 0' >/dev/null && return 0
    sleep 1
  done
  echo "draw $2 not settled after 40s, is ./demo/devnet.sh backend running?" >&2; return 1
}

scenario_() {
  echo "hash of this run: $HASH"
  echo "1. originator registers the fingerprint"
  create "$ORIGINATOR" "$T_FP" "$(jq -n --arg o "$ORIGINATOR" --arg r "$REGISTRY" --arg s "$SCHEMA" --arg h "$HASH" '{originator: $o, registry: $r, schemaId: $s, hash: $h}')" | created CollateralFingerprint
  sleep 4
  echo "2. two bilateral facilities on the same hash"
  FAC_A=$(facility "$LENDER_A" 1000000.0 0.085); echo "   facility A $FAC_A"
  FAC_B=$(facility "$LENDER_B" 750000.0 0.091);  echo "   facility B $FAC_B"
  echo "3. lender A draws"
  DRAW_A=$(draw "$LENDER_A" "$FAC_A" 1000000.0); wait_settled "$LENDER_A" "$DRAW_A"
  echo "4. lender B draws on the same hash: collision"
  DRAW_B=$(draw "$LENDER_B" "$FAC_B" 750000.0); wait_settled "$LENDER_B" "$DRAW_B"
  echo "5. lender A repays and releases"
  CLAIM_A=$(acs_of "$LENDER_A" | jq -r --arg h "$HASH" '.[] | select((.templateId | endswith(":Claim")) and .createArgument.hash == $h) | .contractId' | head -1)
  exercise "$LENDER_A" "$T_CLAIM" "$CLAIM_A" Claim_Release '{}' >/dev/null
  sleep 3
  echo "6. lender B retries: settles"
  DRAW_B2=$(draw "$LENDER_B" "$FAC_B" 750000.0); wait_settled "$LENDER_B" "$DRAW_B2"
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
    '{beginExclusive: 0, endInclusive: $e, updateFormat: {includeTransactions: {transactionShape: "TRANSACTION_SHAPE_ACS_DELTA", eventFormat: {filtersByParty: {($p): {cumulative: [{identifierFilter: {WildcardFilter: {value: {includeCreatedEventBlob: false}}}}]}}, verbose: false}}}}')" \
    | jq -r '.[] | .update.Transaction.value? // empty | "offset \(.offset)  \(.updateId)  " + ([.events[] | (.CreatedEvent // .ArchivedEvent).templateId | split(":") | .[-1]] | join(","))'
}

case "${1-}" in
  whoami) whoami_ ;; parties) parties_ ;; delegate) delegate_ ;; backend) backend_ ;;
  scenario) scenario_ ;; acs) acs_ ;; txids) txids_ ;;
  *) sed -n 2,30p "$0"; exit 1 ;;
esac
