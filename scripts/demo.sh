#!/usr/bin/env bash
# End-to-end walkthrough of the core flows against a running stack (local or compose).
#   ./scripts/demo.sh                 # API at http://localhost:3000
#   API=http://host:port ./scripts/demo.sh
# Requires: curl, jq, node (for TOTP codes). Uses seeded demo accounts (npm run seed).
set -euo pipefail

API="${API:-http://localhost:3000}"
V1="$API/v1"
TOTP_SECRET="${TOTP_SECRET:-JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP}"
DIR="$(cd "$(dirname "$0")/.." && pwd)"

bold() { printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; }
ok() { printf '  \033[32m✔ %s\033[0m\n' "$*"; }
fail() { printf '  \033[31m✘ %s\033[0m\n' "$*"; exit 1; }
key() { printf 'demo-%s-%s' "$1" "$(date +%s%N | tail -c 10)"; }
totp() { (cd "$DIR" && npx -y tsx scripts/totp.ts "$TOTP_SECRET"); }

# req METHOD PATH [TOKEN] [BODY] [IDEMPOTENCY_KEY] -> prints "<status>\n<body>"
req() {
  local method=$1 path=$2 token=${3:-} body=${4:-} idem=${5:-}
  local args=(-s -o /tmp/amrutam_demo_body -w '%{http_code}' -X "$method" "$V1$path" -H 'content-type: application/json')
  [[ -n $token ]] && args+=(-H "authorization: Bearer $token")
  [[ -n $idem ]] && args+=(-H "idempotency-key: $idem")
  [[ -n $body ]] && args+=(-d "$body")
  local status; status=$(curl "${args[@]}")
  echo "$status"; cat /tmp/amrutam_demo_body; echo
}
status_of() { head -n1 <<<"$1"; }
body_of() { tail -n +2 <<<"$1"; }

login_mfa() { # email password -> access token (handles the MFA challenge)
  local r; r=$(req POST /auth/login "" "{\"email\":\"$1\",\"password\":\"$2\"}")
  local b; b=$(body_of "$r")
  if [[ $(jq -r .status <<<"$b") == "mfa_required" ]]; then
    local challenge; challenge=$(jq -r .mfaToken <<<"$b")
    r=$(req POST /auth/mfa/verify "" "{\"mfaToken\":\"$challenge\",\"code\":\"$(totp)\"}")
    b=$(body_of "$r")
  fi
  jq -er .accessToken <<<"$b" || fail "login failed for $1: $b"
}

bold "Health"
curl -sf "$API/health/ready" | jq -c . && ok "API ready"

bold "1. Discovery: search verified doctors (full-text + filters, cached, keyset pagination)"
r=$(req GET "/doctors?specialty=womens-health&sort=rating&limit=3")
body_of "$r" | jq -c '.items[] | {displayName, specialties, feePaise, rating, nextAvailableAt}'
curl -s "$V1/doctors?q=digestive&limit=2" | jq -c '{names: [.items[].displayName], nextCursor}'

bold "2+3. Doctor logs in with password + TOTP (MFA mandatory) and publishes a slot starting in ~7 min"
FROM=$(node -e 'const d=new Date(Date.now()+7*60e3);d.setSeconds(0,0);console.log(d.toISOString())')
TO=$(node -e "console.log(new Date(new Date('$FROM').getTime()+15*60e3).toISOString())")
START_N=$(( RANDOM % 12 + 1 ))
for i in $(seq 0 11); do
  N=$(( (START_N + i - 1) % 12 + 1 ))
  DOC_TOKEN=$(login_mfa "dr.$N@amrutam.local" 'Doctor@Amrutam2026')
  r=$(req POST /doctors/me/slots "$DOC_TOKEN" "{\"from\":\"$FROM\",\"to\":\"$TO\",\"slotMinutes\":15}" "$(key slots)")
  [[ $(body_of "$r" | jq .created) == 1 ]] && break   # else this doctor already has a slot then; try the next one
done
ok "dr.$N authenticated (amr=pwd+otp)"; body_of "$r" | jq -c .
DOC_ID=$(curl -s "$V1/me" -H "authorization: Bearer $DOC_TOKEN" | jq -r .id)
SLOT_ID=$(curl -s "$V1/doctors/$DOC_ID/slots?from=$FROM" | jq -r '.[0].id')
ok "bookable slot $SLOT_ID"

bold "4. Patients log in"
P1=$(login_mfa patient1@amrutam.local 'Patient@Amrutam2026'); ok "patient1"
P2=$(login_mfa patient2@amrutam.local 'Patient@Amrutam2026'); ok "patient2"

bold "5. Race: two patients book the SAME slot concurrently — exactly one wins"
BOOK_BODY="{\"slotId\":\"$SLOT_ID\",\"reason\":\"Acidity and bloating for 2 weeks\"}"
K1=$(key book1); K2=$(key book2)
req POST /bookings "$P1" "$BOOK_BODY" "$K1" > /tmp/amrutam_r1 &
req POST /bookings "$P2" "$BOOK_BODY" "$K2" > /tmp/amrutam_r2 &
wait
S1=$(head -n1 /tmp/amrutam_r1); S2=$(head -n1 /tmp/amrutam_r2)
echo "  patient1 -> $S1, patient2 -> $S2"
if [[ $S1 == 201 ]]; then WIN=$P1; WIN_KEY=$K1; WIN_BODY=$(tail -n +2 /tmp/amrutam_r1); LOSE=/tmp/amrutam_r2;
elif [[ $S2 == 201 ]]; then WIN=$P2; WIN_KEY=$K2; WIN_BODY=$(tail -n +2 /tmp/amrutam_r2); LOSE=/tmp/amrutam_r1;
else fail "nobody won the slot"; fi
tail -n +2 $LOSE | jq -c '{status, code, detail}'
ok "one 201, the other 409 SLOT_UNAVAILABLE"
CONSULT_ID=$(jq -r .consultation.id <<<"$WIN_BODY"); PAYMENT_ID=$(jq -r .payment.id <<<"$WIN_BODY")
jq -c '{consultation: .consultation.status, payment: .payment.status, holdExpiresAt}' <<<"$WIN_BODY"

bold "6. Idempotency: retry with the same key replays the stored response; a different payload is rejected"
curl -s -D - -o /dev/null -X POST "$V1/bookings" -H "authorization: Bearer $WIN" -H 'content-type: application/json' \
  -H "idempotency-key: $WIN_KEY" -d "$BOOK_BODY" | grep -iE '^(HTTP|idempotent-replayed)' | sed 's/^/  /'
r=$(req POST /bookings "$WIN" "{\"slotId\":\"$SLOT_ID\"}" "$WIN_KEY"); body_of "$r" | jq -c '{status, code}'
r=$(req POST /bookings "$WIN" "$BOOK_BODY"); body_of "$r" | jq -c '{status, code}'

bold "7. Payment: provider checkout -> HMAC-signed webhook -> consultation confirmed (saga step T3)"
r=$(req POST "/payments/$PAYMENT_ID/mock-checkout" "$WIN" '{"outcome":"success"}' "$(key pay)"); body_of "$r" | jq -c .
curl -s -X POST "$V1/payments/webhook" -H 'content-type: application/json' -H 'x-mockpay-signature: t=1,v1=forged' \
  -d '{"id":"evt_forged","type":"payment.captured","data":{"orderId":"x","amountPaise":1}}' | jq -c '{status, code}'
ok "forged webhook rejected"
curl -s "$V1/consultations/$CONSULT_ID" -H "authorization: Bearer $WIN" | jq -c '{status, paymentStatus, reason}'

bold "8. RBAC / ownership: the other patient cannot read this consultation (404, audited)"
OTHER=$([[ $WIN == "$P1" ]] && echo "$P2" || echo "$P1")
curl -s "$V1/consultations/$CONSULT_ID" -H "authorization: Bearer $OTHER" | jq -c '{status, code}'

bold "9. Consultation lifecycle: start -> prescribe -> complete (optimistic locking via version)"
r=$(req POST "/consultations/$CONSULT_ID/start" "$DOC_TOKEN" '{}' "$(key start)"); body_of "$r" | jq -c '{status, version}'
r=$(req POST "/consultations/$CONSULT_ID/prescription" "$DOC_TOKEN" '{"items":[{"medicine":"Avipattikar Churna","dosage":"3 g","frequency":"twice daily before meals","durationDays":14},{"medicine":"Triphala","dosage":"1 tsp","frequency":"at bedtime with warm water","durationDays":30}],"advice":"Avoid spicy and fried food; early dinner.","followUpDate":"2026-12-01"}' "$(key rx)")
body_of "$r" | jq -c '{id, pdfStatus, contentHash}'
r=$(req POST "/consultations/$CONSULT_ID/complete" "$DOC_TOKEN" '{"notes":"Pitta aggravation; responded well to diet changes.","expectedVersion":0}' "$(key done)")
body_of "$r" | jq -c '{status, code, detail}'
ok "stale expectedVersion rejected (409 VERSION_CONFLICT)"
VERSION=$(curl -s "$V1/consultations/$CONSULT_ID" -H "authorization: Bearer $DOC_TOKEN" | jq .version)
r=$(req POST "/consultations/$CONSULT_ID/complete" "$DOC_TOKEN" "{\"notes\":\"Pitta aggravation; responded well to diet changes.\",\"expectedVersion\":$VERSION}" "$(key done2)")
body_of "$r" | jq -c '{status, completedAt}'

bold "10. Async job: prescription PDF rendered by the worker, stored in S3-compatible storage"
for _ in $(seq 1 20); do
  st=$(curl -s "$V1/consultations/$CONSULT_ID/prescription" -H "authorization: Bearer $WIN" | jq -r .pdfStatus)
  [[ $st == ready ]] && break; sleep 1
done
echo "  pdfStatus=$st"
curl -s -o /tmp/amrutam_rx.pdf -w '  downloaded %{size_download} bytes (%{content_type})\n' "$V1/consultations/$CONSULT_ID/prescription/pdf" -H "authorization: Bearer $WIN"

bold "11. Cancellation with refund (patient cancels > 2h before: slot released, refund job runs)"
SLOT2=$(curl -s "$V1/doctors/$DOC_ID/slots" | jq -r '.[0].id')
r=$(req POST /bookings "$OTHER" "{\"slotId\":\"$SLOT2\"}" "$(key book3)"); C2=$(body_of "$r" | jq -r .consultation.id); P2ID=$(body_of "$r" | jq -r .payment.id)
req POST "/payments/$P2ID/mock-checkout" "$OTHER" '{"outcome":"success"}' "$(key pay2)" > /dev/null
r=$(req POST "/consultations/$C2/cancel" "$OTHER" '{"reason":"Feeling better, no longer needed"}' "$(key cancel)"); body_of "$r" | jq -c '{status, paymentStatus}'
sleep 2; curl -s "$V1/payments/$P2ID" -H "authorization: Bearer $OTHER" | jq -c '{status, refundedAt}'

bold "12. Admin (MFA): analytics rollup job + KPIs, audit trail and tamper-evidence check"
ADMIN=$(login_mfa admin@amrutam.local 'Admin@Amrutam2026'); ok "admin authenticated"
TODAY=$(date +%F); TOMORROW=$(node -e 'console.log(new Date(Date.now()+864e5).toISOString().slice(0,10))')
r=$(req POST /admin/analytics/refresh "$ADMIN" "{\"from\":\"$TODAY\",\"to\":\"$TOMORROW\"}" "$(key rollup)"); body_of "$r" | jq -c .
sleep 3
curl -s "$V1/admin/analytics/overview?from=$TODAY&to=$TOMORROW" -H "authorization: Bearer $ADMIN" | jq -c '.totals | {consultations, byStatus, revenuePaise, refundsPaise, cancellationRate, slotUtilization}'
curl -s "$V1/admin/audit-logs?resourceId=$CONSULT_ID&limit=10" -H "authorization: Bearer $ADMIN" | jq -r '.items[] | "  \(.occurred_at)  \(.action)  \(.outcome)  actor=\(.actor_role // "system")"'
curl -s "$V1/admin/audit-logs/verify" -H "authorization: Bearer $ADMIN" | jq -c .
ok "hash chain intact"

bold "Done. Swagger: $API/docs · Mailpit: http://localhost:8025 · Jaeger: http://localhost:16686 · Grafana: http://localhost:3001"
