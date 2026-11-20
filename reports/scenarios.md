# Problem scenarios — 27/27 passed

Run 2026-11-20T19:17:56.108Z against http://localhost:4000. Customers are deep agents talking to the platform agent over A2A with A2UI.

| # | Scenario | Result | Time |
| --- | --- | --- | --- |
| s01 | Kitchens compete for a pizza order; the customer takes the best offer | pass | 1.3 s |
| s02 | Missing item after delivery → automatic partial refund, then a 5-star rating | pass | 2.4 s |
| s03 | Wrong items on a large order → refund above the automatic limit waits for a person | pass | 2.3 s |
| s04 | Nobody decides within the SLA → duty lead paged → later approval still pays out | pass | 3.3 s |
| s05 | Delivery took 75 minutes → automatic €5 credit | pass | 1.7 s |
| s06 | Cold pizza → 30% refund without a human | pass | 2.0 s |
| s07 | Two kitchens reject → the third-closest delivers | pass | 2.4 s |
| s08 | No kitchen accepts → order fails, card released; complaint earns a €5 credit | pass | 2.1 s |
| s09 | Card declined on a huge order → nothing reaches a kitchen | pass | 0.5 s |
| s10 | Customer cancels while the pizza is in the oven → authorization voided | pass | 1.1 s |
| s11 | Cancel after pickup is refused politely; the order still arrives | pass | 1.8 s |
| s12 | Courier crashes after pickup → order fails, payment voided, courier job cancelled | pass | 1.6 s |
| s13 | Mall bidding war for running shoes → voucher → redeemed once only | pass | 0.1 s |
| s14 | Voucher not used in time → expires automatically | pass | 5.2 s |
| s15 | A merchant's own agent is down → the auction still completes on its standing policy | pass | 0.0 s |
| s16 | Full spin class → waitlist → a cancellation promotes the next person automatically | pass | 0.6 s |
| s17 | Class starts: one member checks in, one no-shows | pass | 5.2 s |
| s18 | Live tracking: courier GPS pings stream to the customer in real time | pass | 3.6 s |
| s19 | Phone: outbound call on order updates; a bad call opens a case; forged webhooks rejected | pass | 0.7 s |
| s20 | Customer revokes their assistant → it can no longer order for them | pass | 0.0 s |
| s21 | One agent, any business: food, gym and mall offers in one conversation, each in its own theme | pass | 0.3 s |
| s22 | App button "call me back": the AI phones with the order in context and the call continues there | pass | 2.5 s |
| s23 | Physical button, double press: "my usual" at the best competing price, confirmed by voice | pass | 3.1 s |
| s24 | Button pressed five times in a row → one call, not five | pass | 1.9 s |
| s25 | Nobody answers → two retries → a text message instead | pass | 6.6 s |
| s26 | Pressed during quiet hours → scheduled for morning; a long press cancels it | pass | 1.4 s |
| s27 | Support misses its SLA → the AI calls the customer on its own | pass | 6.8 s |

## s01. Kitchens compete for a pizza order; the customer takes the best offer

- 5 kitchens offered. 5 offers from 6 of 6 nearby providers. Best: Slice Mitte (the original), 2× Margherita from Slice Network, €20.00.
- Order ord_mwpd1qo58a271146 pinned to Slice Mitte (the original); €20.00 authorized.
- Delivered; payment captured.

<details><summary>Conversation</summary>

- **Ada:** get offers for 2 margherita
- **agent:** 5 offers from 6 of 6 nearby providers. Best: Slice Mitte (the original), 2× Margherita from Slice Network, €20.00.
- **Ada:** [taps] "Order this"
- **agent:** Ordered from Slice Mitte (the original) for €20.00. Order number ord_mwpd1qo58a271146.

</details>

## s02. Missing item after delivery → automatic partial refund, then a 5-star rating

- Case case_mwpd1svqbd0c2e51: "I'm sorry. I've refunded €10.20 to your original payment. (case case_mwpd1svqbd0c2e51)" → €10.20 of €25.50 refunded automatically.
- Customer tapped 5; case closed with CSAT 5.

<details><summary>Conversation</summary>

- **Ben:** I want 2 margherita and garlic knots, confirm
- **agent:** Ordered. Your order number is ord_mwpd1rm7010ac437.
- **Ben:** my garlic knots were missing from ord_mwpd1rm7010ac437
- **agent:** I'm sorry. I've refunded €10.20 to your original payment. (case case_mwpd1svqbd0c2e51)
- **Ben:** [taps] "5"
- **agent:** Thanks for the rating.

</details>

## s03. Wrong items on a large order → refund above the automatic limit waits for a person

- Refund would be €29.88 (> €15): case waits for approval.
- Support lead approved; €29.88 refunded to the card.

<details><summary>Conversation</summary>

- **Cleo:** I want 4 night owl and 2 diavola, confirm
- **agent:** Ordered. Your order number is ord_mwpd1tgfb8cba283.
- **Cleo:** you sent the wrong pizzas for ord_mwpd1tgfb8cba283
- **agent:** I'm sorry. A refund of €29.88 needs a quick check by our team; you'll hear back within 15 minutes. (case case_mwpd1utgfcca6d09)

</details>

## s04. Nobody decides within the SLA → duty lead paged → later approval still pays out

- 15-minute approval SLA (800 ms here) passed: status sla_breached, duty lead paged.
- Lead approved a €10.00 goodwill refund after the breach; customer refunded.

<details><summary>Conversation</summary>

- **Dario:** I want 5 night owl, confirm
- **agent:** Ordered. Your order number is ord_mwpd1v8ob8322430.

</details>

## s05. Delivery took 75 minutes → automatic €5 credit

- "Sorry about the wait (75 min). I've added a €5.00 credit to your account. (case case_mwpd1ysc2fe29a50)" Credit recorded: €5.00.

<details><summary>Conversation</summary>

- **Eli:** I want 1 margherita, confirm
- **agent:** Ordered. Your order number is ord_mwpd1xr7890aace6.
- **Eli:** my order ord_mwpd1xr7890aace6 was so late
- **agent:** Sorry about the wait (75 min). I've added a €5.00 credit to your account. (case case_mwpd1ysc2fe29a50)

</details>

## s06. Cold pizza → 30% refund without a human

- Quality issue: €5.15 (30% of €17.15) refunded automatically.

<details><summary>Conversation</summary>

- **Fia:** I want 1 funghi and 1 lemonade, confirm
- **agent:** Ordered. Your order number is ord_mwpd1z3ue4accf6f.
- **Fia:** the pizza from ord_mwpd1z3ue4accf6f arrived cold
- **agent:** I'm sorry. I've refunded €5.15 to your original payment. (case case_mwpd20d09f61f1a5)

</details>

## s07. Two kitchens reject → the third-closest delivers

- ber-mitte-01 said "oven full"; order moved on.
- ber-alex-02 said "oven full"; order moved on.
- Delivered by Basil & Bloom Kollwitzplatz after trying ber-mitte-01 → ber-alex-02 → ber-kollwitz-05.

<details><summary>Conversation</summary>

- **Gus:** I want 2 margherita, confirm
- **agent:** Ordered. Your order number is ord_mwpd20ou27bae17f.

</details>

## s08. No kitchen accepts → order fails, card released; complaint earns a €5 credit

- All three kitchens declined: order failed, authorization voided (customer not charged).
- Customer complained; €5.00 credit applied automatically.

<details><summary>Conversation</summary>

- **Hana:** I want 1 diavola, confirm
- **agent:** Ordered. Your order number is ord_mwpd22k36180c820.
- **Hana:** my order ord_mwpd22k36180c820 never arrived
- **agent:** Sorry about the wait (0 min). I've added a €5.00 credit to your account. (case case_mwpd23w8eebd4cd4)

</details>

## s09. Card declined on a huge order → nothing reaches a kitchen

- Card declined (€580 > limit): order failed before any kitchen was notified.

<details><summary>Conversation</summary>

- **Ivo:** I want 40 night owl, confirm
- **agent:** Ordered. Your order number is ord_mwpd2477a9404957.

</details>

## s10. Customer cancels while the pizza is in the oven → authorization voided

- "Order ord_mwpd24kk70f695e0 is being cancelled and the payment released." → cancelled, payment voided.

<details><summary>Conversation</summary>

- **Jo:** I want 1 margherita, confirm
- **agent:** Ordered. Your order number is ord_mwpd24kk70f695e0.
- **Jo:** please cancel ord_mwpd24kk70f695e0
- **agent:** Order ord_mwpd24kk70f695e0 is being cancelled and the payment released.

</details>

## s11. Cancel after pickup is refused politely; the order still arrives

- Agent: "Order is out_for_delivery and can no longer be cancelled" Order delivered and charged normally.

<details><summary>Conversation</summary>

- **Kai:** I want 1 funghi, confirm
- **agent:** Ordered. Your order number is ord_mwpd25f8c6b0e9bf.
- **Kai:** cancel ord_mwpd25f8c6b0e9bf
- **agent:** Order is out_for_delivery and can no longer be cancelled

</details>

## s12. Courier crashes after pickup → order fails, payment voided, courier job cancelled

- Courier reported failure: compensations ran (courier job cancelled, authorization voided).

<details><summary>Conversation</summary>

- **Lou:** I want 2 diavola, confirm
- **agent:** Ordered. Your order number is ord_mwpd26tj8cd6a194.

</details>

## s13. Mall bidding war for running shoes → voucher → redeemed once only

- 2 offers from 5 of 5 nearby providers. Best: StrideLab, Trail runner GTX, €109.65 (Price lowered to compete).
- Voucher 4E7369C7 at StrideLab for €109.65.
- Shop scanned it at the till; a second scan was refused (409).

<details><summary>Conversation</summary>

- **Mai:** I need running shoes
- **agent:** 2 offers from 5 of 5 nearby providers. Best: StrideLab, Trail runner GTX, €109.65 (Price lowered to compete).
- **Mai:** [taps] "Claim offer"
- **agent:** Done: show code 4E7369C7 at StrideLab.

</details>

## s14. Voucher not used in time → expires automatically

- Voucher 5D95775F issued with a 5 s lifetime (30 min in production).
- Durable timer fired: voucher expired, offer slot released.

## s15. A merchant's own agent is down → the auction still completes on its standing policy

- Voltbox's A2A agent refused the connection; its fallback offer (€79.00) was used. 5/5 answered.

## s16. Full spin class → waitlist → a cancellation promotes the next person automatically

- Nia: Booked: Spin 45 at FlexGym Mitte. Booking bk_mwpd2c9q734eb493.
- Oto: Booked: Spin 45 at FlexGym Mitte. Booking bk_mwpd2cdh2bb56a3f.
- Pia: Full: you're number 1 on the waitlist (booking bk_mwpd2ch80048fbdd).
- Nia cancelled; Pia was promoted from the waitlist and notified.

<details><summary>Conversation</summary>

- **Nia:** book cls-mitte-spin
- **agent:** Booked: Spin 45 at FlexGym Mitte. Booking bk_mwpd2c9q734eb493.
- **Nia:** cancel bk_mwpd2c9q734eb493
- **agent:** Cancelled. If someone was waiting, they get your spot.
- **Oto:** book cls-mitte-spin
- **agent:** Booked: Spin 45 at FlexGym Mitte. Booking bk_mwpd2cdh2bb56a3f.
- **Pia:** book cls-mitte-spin
- **agent:** Full: you're number 1 on the waitlist (booking bk_mwpd2ch80048fbdd).

</details>

## s17. Class starts: one member checks in, one no-shows

- Quin checked in → attended; Rae never arrived → no_show recorded at class end.

## s18. Live tracking: courier GPS pings stream to the customer in real time

- Customer's stream received 5 live positions (progress 0.20 → 0.40 → 0.60 → 0.80 → 0.80), then "delivered".

<details><summary>Conversation</summary>

- **Sol:** I want 1 margherita, confirm
- **agent:** Ordered. Your order number is ord_mwpd2gpoa482cbee.

</details>

## s19. Phone: outbound call on order updates; a bad call opens a case; forged webhooks rejected

- Order update placed as an ElevenLabs call (dry_run: no API key configured).
- Failed call → support case case_mwpd2jqs5f0020b5 opened for the caller; forged signature → 401.

## s20. Customer revokes their assistant → it can no longer order for them

- After revoking, the same assistant asked again and was told: "Sign in, or give a name and phone number."

<details><summary>Conversation</summary>

- **Uma:** I want 1 margherita, confirm
- **agent:** Ordered. Your order number is ord_mwpd2k1ye868c9b2.
- **Uma:** I want 1 margherita, confirm
- **agent:** Sign in, or give a name and phone number.

</details>

## s21. One agent, any business: food, gym and mall offers in one conversation, each in its own theme

- "find me a yoga class" → Upcoming: Morning flow yoga at FlexGym Mitte 21:13 UTC (12 spots); Breath & stretch at Studio Ruhe (partner) 2
- "get offers for 2 margherita" → 4 offers from 6 of 6 nearby providers. Best: Night Owl Kotti, 2× Margherita from Night Owl Pizza, €15.31 (Pric
- "I want a flat white coffee" → 2 offers from 5 of 5 nearby providers. Best: Crema Bar, Flat white + cantucci, €3.84 (Beats the nearby price).
- 6 distinct provider themes rendered by the same agent.

<details><summary>Conversation</summary>

- **Vik:** find me a yoga class
- **agent:** Upcoming: Morning flow yoga at FlexGym Mitte 21:13 UTC (12 spots); Breath & stretch at Studio Ruhe (partner) 21:43 UTC (8 spots); Yin yoga at FlexGym Kreuzberg 21:13 UTC (14 spots).
- **Vik:** get offers for 2 margherita
- **agent:** 4 offers from 6 of 6 nearby providers. Best: Night Owl Kotti, 2× Margherita from Night Owl Pizza, €15.31 (Price lowered to compete).
- **Vik:** I want a flat white coffee
- **agent:** 2 offers from 5 of 5 nearby providers. Best: Crema Bar, Flat white + cantucci, €3.84 (Beats the nearby price).

</details>

## s22. App button "call me back": the AI phones with the order in context and the call continues there

- Tapped "Call me back". The agent dialled (ElevenLabs dry run) and opened with: "Hi, about your order from Slice Mitte (the original): it's preparing. What can I do for you?"
- Caller: "where is my pizza?" → agent: "Order. is preparing."
- Post-call webhook closed the callback as completed.

<details><summary>Conversation</summary>

- **Wren:** I want 1 margherita, confirm
- **agent:** Ordered. Your order number is ord_mwpd2ka9771df93a.

</details>

## s23. Physical button, double press: "my usual" at the best competing price, confirmed by voice

- Registered a physical button; the device posts to /v1/buttons/btn_mwpd2n65e28efc42/press.
- Kitchens bid on the usual before dialling. Agent opened: "Hi, it's about your usual: 1× House Lemonade, 2× Margherita from Slice Alexanderplatz for €19.41, about 23 minutes. Shall I order it?"
- Caller: "yes please" → "Ordered from Slice Alexanderplatz for €19.41." (routed to Slice Alexanderplatz, exactly €19.41 authorized).

<details><summary>Conversation</summary>

- **Xia:** I want 2 margherita and a lemonade, confirm
- **agent:** Ordered. Your order number is ord_mwpd2m71a99c27e8.

</details>

## s24. Button pressed five times in a row → one call, not five

- 5 presses → 1 callback (4 merged) → 1 call.

## s25. Nobody answers → two retries → a text message instead

- 3 unanswered calls (minutes apart in production; 0.3 s here) → SMS: "We tried to call you back. Reply or open the app to continue."

## s26. Pressed during quiet hours → scheduled for morning; a long press cancels it

- Quiet hours 20:00–21:00 Berlin time: call scheduled for 20:00 UTC instead of now.
- Long press cancelled it; no call was ever placed.

## s27. Support misses its SLA → the AI calls the customer on its own

- Case case_mwpd2wyo1ab5720a breached its SLA; the platform (system:case case_mwpd2wyo1ab5720a SLA breached) called the customer: "Hi, I'm calling about your support case (wrong item). Sorry for the wait. Can I help sort it out now?"

<details><summary>Conversation</summary>

- **Bo:** I want 5 night owl, confirm
- **agent:** Ordered. Your order number is ord_mwpd2w7yc3a752c6.

</details>
