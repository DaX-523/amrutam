// Write-path load test: book + cancel loop across seeded patients. SLO: p95 < 500 ms.
// Contention is intentional (many VUs race for the same small slot pool): 409s are
// expected and correct; 5xx are not.
//   Start the API with raised per-user limits first (5 demo patients drive all the load):
//   RATE_LIMIT_MAX=1000000 AUTH_RATE_LIMIT_MAX=1000 BOOKING_RATE_LIMIT_MAX=100000 docker compose up -d api
//   docker run --rm -i --network host grafana/k6:0.57.0 run - < load/k6-booking.js
import http from 'k6/http';
import { check } from 'k6';
import { uuidv4 } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';

const API = __ENV.API || 'http://localhost:3000';

export const options = {
  scenarios: {
    bookings: { executor: 'constant-arrival-rate', rate: 20, timeUnit: '1s', duration: '45s', preAllocatedVUs: 30, maxVUs: 100 },
  },
  thresholds: {
    'http_req_duration{kind:write}': ['p(95)<500'],
    'checks{check:no_5xx}': ['rate==1'],
  },
};

export function setup() {
  const tokens = [];
  for (let i = 1; i <= 5; i++) {
    const r = http.post(`${API}/v1/auth/login`, JSON.stringify({ email: `patient${i}@amrutam.local`, password: 'Patient@Amrutam2026' }), {
      headers: { 'content-type': 'application/json' },
    });
    tokens.push(r.json('accessToken'));
  }
  const doctors = http.get(`${API}/v1/doctors?limit=50`).json('items');
  const slots = [];
  for (const d of doctors.slice(0, 6)) {
    for (const s of http.get(`${API}/v1/doctors/${d.id}/slots`).json()) slots.push(s.id);
  }
  return { tokens, slots };
}

export default function ({ tokens, slots }) {
  const token = tokens[Math.floor(Math.random() * tokens.length)];
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` };
  const slotId = slots[Math.floor(Math.random() * slots.length)];
  const res = http.post(`${API}/v1/bookings`, JSON.stringify({ slotId }), {
    headers: { ...headers, 'idempotency-key': uuidv4() },
    tags: { kind: 'write', name: 'book' },
  });
  check(res, { no_5xx: (r) => r.status < 500, 'booked or contended': (r) => [201, 409].includes(r.status) }, { check: 'no_5xx' });
  if (res.status === 201) {
    const id = res.json('consultation.id');
    const c = http.post(`${API}/v1/consultations/${id}/cancel`, JSON.stringify({ reason: 'load test cleanup' }), {
      headers: { ...headers, 'idempotency-key': uuidv4() },
      tags: { kind: 'write', name: 'cancel' },
    });
    check(c, { no_5xx: (r) => r.status < 500 }, { check: 'no_5xx' });
  }
}
