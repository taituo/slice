# Load test — 40 people, 60 s, ~1500 ms think time

Run 2026-11-20T18:55:13.729Z against http://localhost:4000 (seed 7). 90 agent/API calls, 0 errors (0.0%), 1.5 calls/s.

| Action | Calls | p50 ms | p95 ms | p99 ms | Errors |
| --- | --- | --- | --- | --- | --- |
| book_class | 6 | 165 | 189 | 189 | 0 |
| browse | 7 | 7 | 23 | 23 | 0 |
| choose_food_offer | 14 | 22 | 42 | 42 | 0 |
| claim_voucher | 9 | 16 | 22 | 22 | 0 |
| find_classes | 12 | 8 | 15 | 15 | 0 |
| offers_food | 14 | 87 | 144 | 144 | 0 |
| offers_retail | 12 | 60 | 75 | 75 | 0 |
| order_status | 7 | 11 | 29 | 29 | 0 |
| voucher_redeem | 9 | 12 | 15 | 15 | 0 |

| Outcome | Count |
| --- | --- |
| bookings | 5 |
| browses | 7 |
| offer rounds | 26 |
| orders | 14 |
| vouchers | 9 |
| vouchers redeemed | 9 |
| waitlisted | 1 |
| orders delivered | 14 |
| support cases | 0 |
| refunds and credits | €0.00 |

Orders still in flight when the run ends finish on their own; the workflows are durable.