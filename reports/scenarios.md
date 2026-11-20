# Problem scenarios — 21/21 passed

Run 2026-11-20T18:53:52.585Z against http://localhost:4000. Customers are deep agents talking to the platform agent over A2A with A2UI.

| # | Scenario | Result | Time |
| --- | --- | --- | --- |
| s01 | Kitchens compete for a pizza order; the customer takes the best offer | pass | 1.4 s |
| s02 | Missing item after delivery → automatic partial refund, then a 5-star rating | pass | 2.5 s |
| s03 | Wrong items on a large order → refund above the automatic limit waits for a person | pass | 2.2 s |
| s04 | Nobody decides within the SLA → duty lead paged → later approval still pays out | pass | 3.4 s |
| s05 | Delivery took 75 minutes → automatic €5 credit | pass | 1.6 s |
| s06 | Cold pizza → 30% refund without a human | pass | 2.2 s |
| s07 | Two kitchens reject → the third-closest delivers | pass | 2.4 s |
| s08 | No kitchen accepts → order fails, card released; complaint earns a €5 credit | pass | 2.0 s |
| s09 | Card declined on a huge order → nothing reaches a kitchen | pass | 0.5 s |
| s10 | Customer cancels while the pizza is in the oven → authorization voided | pass | 1.1 s |
| s11 | Cancel after pickup is refused politely; the order still arrives | pass | 1.8 s |
| s12 | Courier crashes after pickup → order fails, payment voided, courier job cancelled | pass | 1.7 s |
| s13 | Mall bidding war for running shoes → voucher → redeemed once only | pass | 0.1 s |
| s14 | Voucher not used in time → expires automatically | pass | 5.3 s |
| s15 | A merchant's own agent is down → the auction still completes on its standing policy | pass | 0.0 s |
| s16 | Full spin class → waitlist → a cancellation promotes the next person automatically | pass | 0.7 s |
| s17 | Class starts: one member checks in, one no-shows | pass | 5.2 s |
| s18 | Live tracking: courier GPS pings stream to the customer in real time | pass | 3.6 s |
| s19 | Phone: outbound call on order updates; a bad call opens a case; forged webhooks rejected | pass | 0.7 s |
| s20 | Customer revokes their assistant → it can no longer order for them | pass | 0.0 s |
| s21 | One agent, any business: food, gym and mall offers in one conversation, each in its own theme | pass | 0.2 s |

## s01. Kitchens compete for a pizza order; the customer takes the best offer

- 5 kitchens offered. 5 offers from 6 of 6 nearby providers. Best: Slice Alexanderplatz, 2× Margherita from Slice Network, €15.44 (15% off this week).
- Order ord_mwpc79usa4eff4bb pinned to Slice Alexanderplatz; €15.44 authorized.
- Delivered; payment captured.

<details><summary>Conversation</summary>

- **Ada:** get offers for 2 margherita
- **agent:** 5 offers from 6 of 6 nearby providers. Best: Slice Alexanderplatz, 2× Margherita from Slice Network, €15.44 (15% off this week).
- **Ada:** [taps] "Order this"
- **agent:** Ordered from Slice Alexanderplatz for €15.44. Order number ord_mwpc79usa4eff4bb.

</details>

## s02. Missing item after delivery → automatic partial refund, then a 5-star rating

- Case case_mwpc7c755038fd0a: "I'm sorry. I've refunded €10.20 to your original payment. (case case_mwpc7c755038fd0a)" → €10.20 of €25.50 refunded automatically.
- Customer tapped 5; case closed with CSAT 5.

<details><summary>Conversation</summary>

- **Ben:** I want 2 margherita and garlic knots, confirm
- **agent:** Ordered. Your order number is ord_mwpc7aus0db52dd5.
- **Ben:** my garlic knots were missing from ord_mwpc7aus0db52dd5
- **agent:** I'm sorry. I've refunded €10.20 to your original payment. (case case_mwpc7c755038fd0a)
- **Ben:** [taps] "5"
- **agent:** Thanks for the rating.

</details>

## s03. Wrong items on a large order → refund above the automatic limit waits for a person

- Refund would be €29.88 (> €15): case waits for approval.
- Support lead approved; €29.88 refunded to the card.

<details><summary>Conversation</summary>

- **Cleo:** I want 4 night owl and 2 diavola, confirm
- **agent:** Ordered. Your order number is ord_mwpc7cr27e72c7bf.
- **Cleo:** you sent the wrong pizzas for ord_mwpc7cr27e72c7bf
- **agent:** I'm sorry. A refund of €29.88 needs a quick check by our team; you'll hear back within 15 minutes. (case case_mwpc7e0u0055d9b4)

</details>

## s04. Nobody decides within the SLA → duty lead paged → later approval still pays out

- 15-minute approval SLA (800 ms here) passed: status sla_breached, duty lead paged.
- Lead approved a €10.00 goodwill refund after the breach; customer refunded.

<details><summary>Conversation</summary>

- **Dario:** I want 5 night owl, confirm
- **agent:** Ordered. Your order number is ord_mwpc7egyd7cdfd8d.

</details>

## s05. Delivery took 75 minutes → automatic €5 credit

- "Sorry about the wait (75 min). I've added a €5.00 credit to your account. (case case_mwpc7i0yc02f195f)" Credit recorded: €5.00.

<details><summary>Conversation</summary>

- **Eli:** I want 1 margherita, confirm
- **agent:** Ordered. Your order number is ord_mwpc7h2u1ae01ab7.
- **Eli:** my order ord_mwpc7h2u1ae01ab7 was so late
- **agent:** Sorry about the wait (75 min). I've added a €5.00 credit to your account. (case case_mwpc7i0yc02f195f)

</details>

## s06. Cold pizza → 30% refund without a human

- Quality issue: €5.15 (30% of €17.15) refunded automatically.

<details><summary>Conversation</summary>

- **Fia:** I want 1 funghi and 1 lemonade, confirm
- **agent:** Ordered. Your order number is ord_mwpc7icbb1ea4618.
- **Fia:** the pizza from ord_mwpc7icbb1ea4618 arrived cold
- **agent:** I'm sorry. I've refunded €5.15 to your original payment. (case case_mwpc7jos99bf4a74)

</details>

## s07. Two kitchens reject → the third-closest delivers

- ber-mitte-01 said "oven full"; order moved on.
- ber-alex-02 said "oven full"; order moved on.
- Delivered by Basil & Bloom Kollwitzplatz after trying ber-mitte-01 → ber-alex-02 → ber-kollwitz-05.

<details><summary>Conversation</summary>

- **Gus:** I want 2 margherita, confirm
- **agent:** Ordered. Your order number is ord_mwpc7k1v6abc78d0.

</details>

## s08. No kitchen accepts → order fails, card released; complaint earns a €5 credit

- All three kitchens declined: order failed, authorization voided (customer not charged).
- Customer complained; €5.00 credit applied automatically.

<details><summary>Conversation</summary>

- **Hana:** I want 1 diavola, confirm
- **agent:** Ordered. Your order number is ord_mwpc7lwu39b38597.
- **Hana:** my order ord_mwpc7lwu39b38597 never arrived
- **agent:** Sorry about the wait (0 min). I've added a €5.00 credit to your account. (case case_mwpc7n51848dfe76)

</details>

## s09. Card declined on a huge order → nothing reaches a kitchen

- Card declined (€580 > limit): order failed before any kitchen was notified.

<details><summary>Conversation</summary>

- **Ivo:** I want 40 night owl, confirm
- **agent:** Ordered. Your order number is ord_mwpc7ngtfc8638a0.

</details>

## s10. Customer cancels while the pizza is in the oven → authorization voided

- "Order ord_mwpc7nved1f23078 is being cancelled and the payment released." → cancelled, payment voided.

<details><summary>Conversation</summary>

- **Jo:** I want 1 margherita, confirm
- **agent:** Ordered. Your order number is ord_mwpc7nved1f23078.
- **Jo:** please cancel ord_mwpc7nved1f23078
- **agent:** Order ord_mwpc7nved1f23078 is being cancelled and the payment released.

</details>

## s11. Cancel after pickup is refused politely; the order still arrives

- Agent: "Order is out_for_delivery and can no longer be cancelled" Order delivered and charged normally.

<details><summary>Conversation</summary>

- **Kai:** I want 1 funghi, confirm
- **agent:** Ordered. Your order number is ord_mwpc7opy28a33163.
- **Kai:** cancel ord_mwpc7opy28a33163
- **agent:** Order is out_for_delivery and can no longer be cancelled

</details>

## s12. Courier crashes after pickup → order fails, payment voided, courier job cancelled

- Courier reported failure: compensations ran (courier job cancelled, authorization voided).

<details><summary>Conversation</summary>

- **Lou:** I want 2 diavola, confirm
- **agent:** Ordered. Your order number is ord_mwpc7q3xafd1478b.

</details>

## s13. Mall bidding war for running shoes → voucher → redeemed once only

- 2 offers from 5 of 5 nearby providers. Best: StrideLab, Trail runner GTX, €109.65 (Price lowered to compete).
- Voucher A4B326EF at StrideLab for €109.65.
- Shop scanned it at the till; a second scan was refused (409).

<details><summary>Conversation</summary>

- **Mai:** I need running shoes
- **agent:** 2 offers from 5 of 5 nearby providers. Best: StrideLab, Trail runner GTX, €109.65 (Price lowered to compete).
- **Mai:** [taps] "Claim offer"
- **agent:** Done: show code A4B326EF at StrideLab.

</details>

## s14. Voucher not used in time → expires automatically

- Voucher E1F4F874 issued with a 5 s lifetime (30 min in production).
- Durable timer fired: voucher expired, offer slot released.

## s15. A merchant's own agent is down → the auction still completes on its standing policy

- Voltbox's A2A agent refused the connection; its fallback offer (€79.00) was used. 5/5 answered.

## s16. Full spin class → waitlist → a cancellation promotes the next person automatically

- Nia: Booked: Spin 45 at FlexGym Mitte. Booking bk_mwpc7vlt43c32be4.
- Oto: Booked: Spin 45 at FlexGym Mitte. Booking bk_mwpc7vpqaf0bd9d2.
- Pia: Full: you're number 1 on the waitlist (booking bk_mwpc7vto95c586b9).
- Nia cancelled; Pia was promoted from the waitlist and notified.

<details><summary>Conversation</summary>

- **Nia:** book cls-mitte-spin
- **agent:** Booked: Spin 45 at FlexGym Mitte. Booking bk_mwpc7vlt43c32be4.
- **Nia:** cancel bk_mwpc7vlt43c32be4
- **agent:** Cancelled. If someone was waiting, they get your spot.
- **Oto:** book cls-mitte-spin
- **agent:** Booked: Spin 45 at FlexGym Mitte. Booking bk_mwpc7vpqaf0bd9d2.
- **Pia:** book cls-mitte-spin
- **agent:** Full: you're number 1 on the waitlist (booking bk_mwpc7vto95c586b9).

</details>

## s17. Class starts: one member checks in, one no-shows

- Quin checked in → attended; Rae never arrived → no_show recorded at class end.

## s18. Live tracking: courier GPS pings stream to the customer in real time

- Customer's stream received 5 live positions (progress 0.20 → 0.40 → 0.60 → 0.80 → 0.80), then "delivered".

<details><summary>Conversation</summary>

- **Sol:** I want 1 margherita, confirm
- **agent:** Ordered. Your order number is ord_mwpc802z4d78c12c.

</details>

## s19. Phone: outbound call on order updates; a bad call opens a case; forged webhooks rejected

- Order update placed as an ElevenLabs call (dry_run: no API key configured).
- Failed call → support case case_mwpc834s305ac4fc opened for the caller; forged signature → 401.

## s20. Customer revokes their assistant → it can no longer order for them

- After revoking, the same assistant asked again and was told: "Sign in, or give a name and phone number."

<details><summary>Conversation</summary>

- **Uma:** I want 1 margherita, confirm
- **agent:** Ordered. Your order number is ord_mwpc83fo7c6245e4.
- **Uma:** I want 1 margherita, confirm
- **agent:** Sign in, or give a name and phone number.

</details>

## s21. One agent, any business: food, gym and mall offers in one conversation, each in its own theme

- "find me a yoga class" → Upcoming: Morning flow yoga at FlexGym Mitte 20:50 UTC (12 spots); Breath & stretch at Studio Ruhe (partner) 2
- "get offers for 2 margherita" → 4 offers from 6 of 6 nearby providers. Best: Slice Alexanderplatz, 2× Margherita from Slice Network, €15.65 (1
- "I want a flat white coffee" → 2 offers from 5 of 5 nearby providers. Best: Crema Bar, Flat white + cantucci, €3.84 (Beats the nearby price).
- 6 distinct provider themes rendered by the same agent.

<details><summary>Conversation</summary>

- **Vik:** find me a yoga class
- **agent:** Upcoming: Morning flow yoga at FlexGym Mitte 20:50 UTC (12 spots); Breath & stretch at Studio Ruhe (partner) 21:20 UTC (8 spots); Yin yoga at FlexGym Kreuzberg 20:50 UTC (14 spots).
- **Vik:** get offers for 2 margherita
- **agent:** 4 offers from 6 of 6 nearby providers. Best: Slice Alexanderplatz, 2× Margherita from Slice Network, €15.65 (15% off this week).
- **Vik:** I want a flat white coffee
- **agent:** 2 offers from 5 of 5 nearby providers. Best: Crema Bar, Flat white + cantucci, €3.84 (Beats the nearby price).

</details>
