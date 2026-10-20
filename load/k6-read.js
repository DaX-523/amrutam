// Read-path load test: doctor discovery + slot listing. SLO: p95 < 200 ms.
//   docker run --rm -i --network host grafana/k6:0.57.0 run - < load/k6-read.js
//   (or: k6 run -e API=http://localhost:3000 load/k6-read.js)
import http from 'k6/http';
import { check } from 'k6';

const API = __ENV.API || 'http://localhost:3000';
const SPECIALTIES = ['general-ayurveda', 'digestive-health', 'womens-health', 'skin-hair', 'joint-pain', 'mental-wellness', 'sleep'];
const SORTS = ['rating', 'fee', 'experience', 'relevance'];

export const options = {
  scenarios: {
    discovery: {
      executor: 'ramping-arrival-rate',
      startRate: 20,
      timeUnit: '1s',
      preAllocatedVUs: 50,
      maxVUs: 200,
      // ~150 rps peak per pod ≈ 3x the projected peak read load of the whole fleet / pod count
      stages: [
        { target: 150, duration: '20s' },
        { target: 150, duration: '40s' },
        { target: 0, duration: '5s' },
      ],
    },
  },
  thresholds: {
    'http_req_duration{kind:read}': ['p(95)<200'],
    http_req_failed: ['rate<0.001'],
    checks: ['rate>0.999'],
  },
};

export function setup() {
  const res = http.get(`${API}/v1/doctors?limit=50`);
  return { doctorIds: res.json('items').map((d) => d.id) };
}

export default function (data) {
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  const r = Math.random();
  let res;
  if (r < 0.5) {
    res = http.get(`${API}/v1/doctors?specialty=${pick(SPECIALTIES)}&sort=${pick(SORTS)}&limit=20`, { tags: { kind: 'read', name: 'search' } });
  } else if (r < 0.7) {
    res = http.get(`${API}/v1/doctors?q=ayurveda&minRating=4&limit=10`, { tags: { kind: 'read', name: 'search_text' } });
  } else {
    res = http.get(`${API}/v1/doctors/${pick(data.doctorIds)}/slots`, { tags: { kind: 'read', name: 'slots' } });
  }
  check(res, { 'status is 200': (x) => x.status === 200 });
}
