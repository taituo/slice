# Load test — 150 people, 60 s, ~200 ms think time

Run 2026-11-20T18:56:25.992Z against http://localhost:4000 (seed 7). 1260 agent/API calls, 0 errors (0.0%), 21.0 calls/s.

| Action | Calls | p50 ms | p95 ms | p99 ms | Errors |
| --- | --- | --- | --- | --- | --- |
| book_class | 111 | 1329 | 5853 | 6379 | 0 |
| browse | 175 | 10 | 22 | 37 | 0 |
| choose_food_offer | 164 | 112 | 178 | 206 | 0 |
| claim_voucher | 80 | 111 | 157 | 179 | 0 |
| find_classes | 180 | 10 | 23 | 30 | 0 |
| offers_food | 210 | 830 | 6107 | 6519 | 0 |
| offers_retail | 95 | 2809 | 5708 | 6460 | 0 |
| order_status | 168 | 115 | 4856 | 5632 | 0 |
| voucher_redeem | 77 | 111 | 260 | 301 | 0 |

| Outcome | Count |
| --- | --- |
| bookings | 29 |
| browses | 175 |
| offer rounds | 305 |
| orders | 164 |
| vouchers | 80 |
| vouchers redeemed | 77 |
| waitlisted | 82 |
| orders accepted | 2 |
| orders delivered | 24 |
| orders failed | 19 |
| orders out_for_delivery | 57 |
| orders payment_authorized | 14 |
| orders preparing | 26 |
| orders ready | 20 |
| orders routed | 2 |
| support cases | 0 |
| refunds and credits | €0.00 |

Orders still in flight when the run ends finish on their own; the workflows are durable.