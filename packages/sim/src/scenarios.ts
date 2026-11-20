/**
 * Problem scenarios, end to end. Each one is a short story played by dummy customer agents (deep
 * agents talking to the platform agent over A2A + A2UI), kitchen and courier actors, and the support
 * team, against the real API, Temporal workflows and Postgres. The report shows what actually
 * happened — refunds, credits, reroutes, voids — and checks it against policy.
 *
 *   npm run scenarios            (stack must be running; writes reports/scenarios.md)
 *   SCENARIO=s05 npm run scenarios
 */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { closePool, getPool } from '@slice/db';
import { formatEur, THEME_METADATA_KEY } from '@slice/shared';
import { signElevenLabs } from '@slice/workflows';
import { adminReq, API, buttonsIn, DummyCustomer, sleep, staff, until, waitForOrder } from './harness';

const HOME = { lat: 52.5302, lng: 13.4011, addressLine: 'Weinbergsweg 3, 10119 Berlin' };
const MALL = { lat: 52.5106, lng: 13.3807, addressLine: 'Leipziger Platz mall' };
const db = () => getPool();
let phoneSeq = 1000 + Math.floor(Math.random() * 8000);
const person = (name: string, tenant = 'slice', position = HOME) => new DummyCustomer({ name, phone: `+49151${String(phoneSeq++).padStart(7, '0')}`, tenant, position }).signIn();

interface Result {
  id: string;
  title: string;
  ok: boolean;
  happened: string[];
  error?: string;
  ms: number;
  transcript: Array<{ from: string; text: string }>;
}

/** Kitchen + courier for one order, as fast as the workflow allows. */
async function drive(orderId: string, to: 'preparing' | 'out_for_delivery' | 'delivered') {
  const v = await waitForOrder(orderId, ['payment_authorized', 'routed']);
  await staff.kitchen(orderId, 'accept', undefined, v.pizzeriaId!);
  await waitForOrder(orderId, ['preparing']);
  if (to === 'preparing') return;
  await staff.kitchen(orderId, 'ready', undefined, v.pizzeriaId!);
  await until(async () => (await staff.order(orderId)).delivery, 8000, 'courier dispatch');
  await staff.delivery(orderId, 'picked_up');
  await waitForOrder(orderId, ['out_for_delivery']);
  if (to === 'out_for_delivery') return;
  await staff.delivery(orderId, 'delivered');
  await waitForOrder(orderId, ['delivered']);
}

async function orderViaAgent(c: DummyCustomer, what: string): Promise<string> {
  await c.say(`${what}, confirm`);
  const orderId = c.findInData((r) => r?.orderId) ?? c.transcript.at(-1)!.text.match(/ord_[a-z0-9]+/)?.[0];
  assert.ok(orderId, `no order id in: ${c.transcript.at(-1)?.text}`);
  return orderId;
}

const payment = async (orderId: string) => (await db().query(`SELECT status, amount_cents, refunded_cents FROM payments WHERE order_id=$1`, [orderId])).rows[0];
const caseRow = async (id: string) => (await db().query(`SELECT * FROM support_cases WHERE id=$1`, [id])).rows[0];
const caseIdIn = (c: DummyCustomer) => c.findInData((r) => r?.caseId) ?? c.transcript.at(-1)!.text.match(/case_[a-z0-9]+/)?.[0];

/** Calls made with the person's own session (app) token. */
async function sessionReq(c: DummyCustomer, method: string, path: string, body?: unknown): Promise<any> {
  const r = await fetch(`${API}${path}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${c.sessionToken}` }, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
  return r.json();
}

/** One spoken turn on a callback: what ElevenLabs sends to our custom-LLM endpoint. */
async function voiceTurn(callbackId: string, said: string): Promise<string> {
  const r = (await fetch(`${API}/v1/voice/llm/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.VOICE_LLM_KEY ?? 'dev-voice-llm-key'}` },
    body: JSON.stringify({ messages: [{ role: 'user', content: said }], elevenlabs_extra_body: { callback_ref: callbackId } }),
  }).then((x) => x.json())) as any;
  return r.choices[0].message.content as string;
}

/** ElevenLabs' signed post-call webhook. */
async function postCall(conversationId: string, result: 'success' | 'failure', summary: string) {
  const body = JSON.stringify({ type: 'post_call_transcription', data: { conversation_id: conversationId, transcript: [{}, {}], analysis: { call_successful: result, transcript_summary: summary } } });
  const res = await fetch(`${API}/v1/voice/elevenlabs/post-call`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'elevenlabs-signature': signElevenLabs(body, process.env.ELEVENLABS_WEBHOOK_SECRET ?? 'dev-elevenlabs-secret') },
    body,
  });
  assert.equal(res.status, 200);
}

type Scenario = { id: string; title: string; run: (log: (s: string) => void, people: DummyCustomer[]) => Promise<void> };

export const scenarios: Scenario[] = [
  {
    id: 's01',
    title: 'Kitchens compete for a pizza order; the customer takes the best offer',
    async run(log, people) {
      const c = await person('Ada');
      people.push(c);
      const r = await c.say('get offers for 2 margherita');
      const buttons = buttonsIn(r.ui).filter((b) => b.action === 'choose_offer');
      assert.ok(buttons.length >= 2, 'at least two competing offers');
      log(`${buttons.length} kitchens offered. ${r.reply}`);
      const offerId = String(buttons[0]!.context.offerId);
      const offer = (await db().query(`SELECT provider_id, price_cents FROM offers WHERE id=$1`, [offerId])).rows[0];
      await c.press('choose_offer', 0);
      const orderId = c.findInData((x) => x?.orderId)!;
      const v = await waitForOrder(orderId, ['payment_authorized']);
      assert.equal(v.pizzeriaId, offer.provider_id, 'routed to the chosen kitchen');
      assert.equal((await payment(orderId)).amount_cents, offer.price_cents, 'authorized exactly the offered price');
      log(`Order ${orderId} pinned to ${v.pizzeriaName}; ${formatEur(offer.price_cents)} authorized.`);
      await drive(orderId, 'delivered');
      assert.equal((await payment(orderId)).status, 'captured');
      log('Delivered; payment captured.');
    },
  },
  {
    id: 's02',
    title: 'Missing item after delivery → automatic partial refund, then a 5-star rating',
    async run(log, people) {
      const c = await person('Ben');
      people.push(c);
      const orderId = await orderViaAgent(c, 'I want 2 margherita and garlic knots');
      await drive(orderId, 'delivered');
      const total = (await payment(orderId)).amount_cents;
      const r = await c.say(`my garlic knots were missing from ${orderId}`);
      const caseId = caseIdIn(c)!;
      const pay = await payment(orderId);
      assert.equal(pay.refunded_cents, Math.round(total * 0.4), 'refund = 40% of the order');
      assert.ok(pay.refunded_cents <= 1500, 'within the automatic limit');
      log(`Case ${caseId}: "${r.reply}" → ${formatEur(pay.refunded_cents)} of ${formatEur(total)} refunded automatically.`);
      await c.press('rate_support', 4); // the "5" button
      const row = await until(async () => {
        const x = await caseRow(caseId);
        return x.status === 'closed' ? x : null;
      }, 8000, 'case closed');
      assert.equal(row.csat, 5);
      log('Customer tapped 5; case closed with CSAT 5.');
    },
  },
  {
    id: 's03',
    title: 'Wrong items on a large order → refund above the automatic limit waits for a person',
    async run(log, people) {
      const c = await person('Cleo');
      people.push(c);
      const orderId = await orderViaAgent(c, 'I want 4 night owl and 2 diavola');
      await drive(orderId, 'delivered');
      const total = (await payment(orderId)).amount_cents;
      await c.say(`you sent the wrong pizzas for ${orderId}`);
      const caseId = caseIdIn(c)!;
      const pending = await caseRow(caseId);
      assert.equal(pending.status, 'awaiting_approval');
      assert.equal((await payment(orderId)).refunded_cents, 0, 'nothing refunded before approval');
      log(`Refund would be ${formatEur(Math.round(total * 0.4))} (> €15): case waits for approval.`);
      await adminReq('POST', `/v1/support/cases/${caseId}/decision`, { approve: true, note: 'Photos confirm wrong order' });
      const pay = await until(async () => {
        const p = await payment(orderId);
        return p.refunded_cents > 0 ? p : null;
      }, 8000, 'refund');
      assert.equal(pay.refunded_cents, Math.round(total * 0.4));
      log(`Support lead approved; ${formatEur(pay.refunded_cents)} refunded to the card.`);
    },
  },
  {
    id: 's04',
    title: 'Nobody decides within the SLA → duty lead paged → later approval still pays out',
    async run(log, people) {
      const c = await person('Dario');
      people.push(c);
      const orderId = await orderViaAgent(c, 'I want 5 night owl');
      await drive(orderId, 'delivered');
      const res = await fetch(`${API}/v1/support/cases`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${c.token}` },
        body: JSON.stringify({ message: 'wrong pizzas, all of them', orderId, timings: { approvalSlaMs: 800, csatDelayMs: 500, csatWaitMs: 500 } }),
      }).then((r) => r.json() as Promise<any>);
      const caseId = res.caseId as string;
      await until(async () => (await caseRow(caseId)).status === 'sla_breached', 8000, 'SLA breach');
      log('15-minute approval SLA (800 ms here) passed: status sla_breached, duty lead paged.');
      await adminReq('POST', `/v1/support/cases/${caseId}/decision`, { approve: true, amountCents: 1000, note: 'Partial goodwill refund' });
      const p = await until(async () => ((await payment(orderId)).refunded_cents === 1000 ? true : null), 8000, 'refund');
      assert.ok(p);
      log('Lead approved a €10.00 goodwill refund after the breach; customer refunded.');
    },
  },
  {
    id: 's05',
    title: 'Delivery took 75 minutes → automatic €5 credit',
    async run(log, people) {
      const c = await person('Eli');
      people.push(c);
      const orderId = await orderViaAgent(c, 'I want 1 margherita');
      await drive(orderId, 'delivered');
      // Fixture: rewind the clock on this order so it "took" 75 minutes.
      await db().query(`UPDATE order_events SET at = at - interval '75 minutes' WHERE order_id=$1 AND type <> 'delivered'`, [orderId]);
      await db().query(`UPDATE orders SET created_at = created_at - interval '75 minutes' WHERE id=$1`, [orderId]);
      const r = await c.say(`my order ${orderId} was so late`);
      const row = await caseRow(caseIdIn(c)!);
      assert.equal(row.category, 'late');
      assert.equal(row.credit_cents, 500);
      log(`"${r.reply}" Credit recorded: ${formatEur(row.credit_cents)}.`);
    },
  },
  {
    id: 's06',
    title: 'Cold pizza → 30% refund without a human',
    async run(log, people) {
      const c = await person('Fia');
      people.push(c);
      const orderId = await orderViaAgent(c, 'I want 1 funghi and 1 lemonade');
      await drive(orderId, 'delivered');
      const total = (await payment(orderId)).amount_cents;
      await c.say(`the pizza from ${orderId} arrived cold`);
      const pay = await payment(orderId);
      assert.equal(pay.refunded_cents, Math.round(total * 0.3));
      log(`Quality issue: ${formatEur(pay.refunded_cents)} (30% of ${formatEur(total)}) refunded automatically.`);
    },
  },
  {
    id: 's07',
    title: 'Two kitchens reject → the third-closest delivers',
    async run(log, people) {
      const c = await person('Gus');
      people.push(c);
      const orderId = await orderViaAgent(c, 'I want 2 margherita');
      for (let i = 0; i < 2; i++) {
        const v = await waitForOrder(orderId, ['payment_authorized', 'routed']);
        const before = v.pizzeriaId;
        await staff.kitchen(orderId, 'reject', 'oven full', before!);
        await until(async () => {
          const x = await staff.order(orderId);
          return x.pizzeriaId && x.pizzeriaId !== before && x.status === 'routed' ? x : null;
        }, 8000, 'reroute');
        log(`${before} said "oven full"; order moved on.`);
      }
      await drive(orderId, 'delivered');
      const v = await staff.order(orderId);
      assert.equal(v.attemptedPizzerias.length, 3);
      log(`Delivered by ${v.pizzeriaName} after trying ${v.attemptedPizzerias.join(' → ')}.`);
    },
  },
  {
    id: 's08',
    title: 'No kitchen accepts → order fails, card released; complaint earns a €5 credit',
    async run(log, people) {
      const c = await person('Hana');
      people.push(c);
      const orderId = await orderViaAgent(c, 'I want 1 diavola');
      for (let i = 0; i < 3; i++) {
        const v = await waitForOrder(orderId, ['payment_authorized', 'routed']);
        await staff.kitchen(orderId, 'reject', 'closing early', v.pizzeriaId!);
        await until(async () => {
          const x = await staff.order(orderId);
          return x.pizzeriaId !== v.pizzeriaId || x.status === 'failed' ? x : null;
        }, 8000, 'next step');
      }
      const v = await waitForOrder(orderId, ['failed']);
      assert.equal(v.failureReason, 'no_kitchen_accepted');
      assert.equal((await payment(orderId)).status, 'voided');
      log('All three kitchens declined: order failed, authorization voided (customer not charged).');
      await c.say(`my order ${orderId} never arrived`);
      const row = await caseRow(caseIdIn(c)!);
      assert.equal(row.credit_cents, 500);
      log('Customer complained; €5.00 credit applied automatically.');
    },
  },
  {
    id: 's09',
    title: 'Card declined on a huge order → nothing reaches a kitchen',
    async run(log, people) {
      const c = await person('Ivo');
      people.push(c);
      const orderId = await orderViaAgent(c, 'I want 40 night owl');
      const v = await waitForOrder(orderId, ['failed']);
      assert.equal(v.failureReason, 'PaymentDeclined');
      const notified = await db().query(`SELECT count(*)::int AS n FROM notifications WHERE order_id=$1 AND recipient LIKE 'pizzeria:%'`, [orderId]);
      assert.equal(notified.rows[0].n, 0);
      log('Card declined (€580 > limit): order failed before any kitchen was notified.');
    },
  },
  {
    id: 's10',
    title: 'Customer cancels while the pizza is in the oven → authorization voided',
    async run(log, people) {
      const c = await person('Jo');
      people.push(c);
      const orderId = await orderViaAgent(c, 'I want 1 margherita');
      await drive(orderId, 'preparing');
      const r = await c.say(`please cancel ${orderId}`);
      await waitForOrder(orderId, ['cancelled']);
      assert.equal((await payment(orderId)).status, 'voided');
      log(`"${r.reply}" → cancelled, payment voided.`);
    },
  },
  {
    id: 's11',
    title: 'Cancel after pickup is refused politely; the order still arrives',
    async run(log, people) {
      const c = await person('Kai');
      people.push(c);
      const orderId = await orderViaAgent(c, 'I want 1 funghi');
      await drive(orderId, 'out_for_delivery');
      const r = await c.say(`cancel ${orderId}`);
      assert.match(r.reply, /can no longer be cancelled/);
      await staff.delivery(orderId, 'delivered');
      await waitForOrder(orderId, ['delivered']);
      log(`Agent: "${r.reply}" Order delivered and charged normally.`);
    },
  },
  {
    id: 's12',
    title: 'Courier crashes after pickup → order fails, payment voided, courier job cancelled',
    async run(log, people) {
      const c = await person('Lou');
      people.push(c);
      const orderId = await orderViaAgent(c, 'I want 2 diavola');
      await drive(orderId, 'out_for_delivery');
      await staff.delivery(orderId, 'failed', 'bike accident');
      const v = await waitForOrder(orderId, ['failed']);
      assert.equal(v.failureReason, 'bike accident');
      assert.equal((await payment(orderId)).status, 'voided');
      const d = (await db().query(`SELECT status FROM deliveries WHERE order_id=$1`, [orderId])).rows[0];
      assert.equal(d.status, 'cancelled');
      log('Courier reported failure: compensations ran (courier job cancelled, authorization voided).');
    },
  },
  {
    id: 's13',
    title: 'Mall bidding war for running shoes → voucher → redeemed once only',
    async run(log, people) {
      const c = await person('Mai', 'nearby', MALL);
      people.push(c);
      const r = await c.say('I need running shoes');
      const offers = buttonsIn(r.ui).filter((b) => b.action === 'choose_offer');
      assert.ok(offers.length >= 2);
      log(r.reply);
      await c.press('choose_offer', 0);
      const v = c.findInData((x) => (x?.code ? x : undefined));
      assert.ok(v?.code, 'voucher issued');
      log(`Voucher ${v.code} at ${v.providerName} for ${formatEur(v.priceCents)}.`);
      const merchantId = (await db().query(`SELECT o.provider_id FROM vouchers v JOIN offers o ON o.id=v.offer_id WHERE v.code=$1`, [v.code])).rows[0].provider_id;
      await adminReq('POST', `/v1/vouchers/${v.code}/redeem`, { merchantId });
      const second = await fetch(`${API}/v1/vouchers/${v.code}/redeem`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-partner-key': 'dev-partner-key' },
        body: JSON.stringify({ merchantId }),
      });
      assert.equal(second.status, 409);
      log('Shop scanned it at the till; a second scan was refused (409).');
    },
  },
  {
    id: 's14',
    title: 'Voucher not used in time → expires automatically',
    async run(log) {
      const o = await staff.offers({ vertical: 'retail', lat: MALL.lat, lng: MALL.lng, query: 'flat white coffee', tenant: 'nearby' });
      const v = await (staff as any).req('POST', `/v1/offers/${o.offers[0]!.id}/accept`, { voucherTtlSeconds: 5 });
      log(`Voucher ${v.code} issued with a 5 s lifetime (30 min in production).`);
      const st = await until(async () => {
        const x = (await db().query(`SELECT status FROM vouchers WHERE code=$1`, [v.code])).rows[0];
        return x.status === 'expired' ? x : null;
      }, 15_000, 'expiry');
      assert.ok(st);
      log('Durable timer fired: voucher expired, offer slot released.');
    },
  },
  {
    id: 's15',
    title: "A merchant's own agent is down → the auction still completes on its standing policy",
    async run(log) {
      await db().query(`UPDATE merchants SET offer_agent_url='http://127.0.0.1:9/a2a' WHERE id='m-voltbox'`);
      try {
        const o = await staff.offers({ vertical: 'retail', lat: MALL.lat, lng: MALL.lng, query: 'wireless earbuds', tenant: 'nearby' });
        assert.ok(o.offers.some((x) => x.providerId === 'm-voltbox'));
        log(`Voltbox's A2A agent refused the connection; its fallback offer (${formatEur(o.offers[0]!.priceCents)}) was used. ${o.providersAnswered}/${o.providersAsked} answered.`);
      } finally {
        await db().query(`UPDATE merchants SET offer_agent_url=NULL WHERE id='m-voltbox'`);
      }
    },
  },
  {
    id: 's16',
    title: 'Full spin class → waitlist → a cancellation promotes the next person automatically',
    async run(log, people) {
      const cls = 'cls-mitte-spin';
      await db().query(`DELETE FROM class_bookings WHERE class_id=$1`, [cls]);
      const [a, b, c] = await Promise.all([person('Nia', 'flexgym'), person('Oto', 'flexgym'), person('Pia', 'flexgym')]);
      people.push(a, b, c);
      const ids: string[] = [];
      for (const p of [a, b, c]) {
        const r = await p.say(`book ${cls}`);
        ids.push(r.reply.match(/bk_[a-z0-9]+/)![0]);
        log(`${p.opts.name}: ${r.reply}`);
      }
      const third = await (staff as any).req('GET', `/v1/bookings/${ids[2]}`);
      assert.equal(third.status, 'waitlisted');
      await a.say(`cancel ${ids[0]}`);
      await until(async () => ((await (staff as any).req('GET', `/v1/bookings/${ids[2]}`)).status === 'confirmed' ? true : null), 8000, 'promotion');
      log(`${a.opts.name} cancelled; ${c.opts.name} was promoted from the waitlist and notified.`);
    },
  },
  {
    id: 's17',
    title: 'Class starts: one member checks in, one no-shows',
    async run(log) {
      const id = `cls-test-${Date.now()}`;
      await db().query(
        `INSERT INTO gym_classes (id, gym_id, title, kind, starts_at, duration_min, capacity, price_cents, instructor)
         VALUES ($1,'g-kreuzberg','Test HIIT','hiit', now() + interval '3 seconds', 0, 5, 1000, 'Sim')`,
        [id],
      );
      // duration 0 → the class "ends" at start; fine for a timing test.
      const book = (n: string) => (staff as any).req('POST', '/v1/bookings', { classId: id, name: n, phone: `+49152${String(phoneSeq++).padStart(7, '0')}`, remindBeforeMin: 0 });
      const [x, y] = await Promise.all([book('Quin'), book('Rae')]);
      await adminReq('POST', `/v1/bookings/${x.bookingId}/check-in`);
      const done = await until(async () => {
        const r = (await db().query(`SELECT id, status FROM class_bookings WHERE class_id=$1`, [id])).rows;
        return r.every((b: any) => ['attended', 'no_show'].includes(b.status)) ? r : null;
      }, 15_000, 'class end');
      const st = Object.fromEntries(done.map((b: any) => [b.id, b.status]));
      assert.equal(st[x.bookingId], 'attended');
      assert.equal(st[y.bookingId], 'no_show');
      log('Quin checked in → attended; Rae never arrived → no_show recorded at class end.');
    },
  },
  {
    id: 's18',
    title: 'Live tracking: courier GPS pings stream to the customer in real time',
    async run(log, people) {
      const c = await person('Sol');
      people.push(c);
      const orderId = await orderViaAgent(c, 'I want 1 margherita');
      const v = await waitForOrder(orderId, ['payment_authorized', 'routed']);
      await staff.kitchen(orderId, 'accept', undefined, v.pizzeriaId!);
      await waitForOrder(orderId, ['preparing']);
      await staff.kitchen(orderId, 'ready', undefined, v.pizzeriaId!);
      await until(async () => (await staff.order(orderId)).delivery, 8000, 'dispatch');
      await staff.delivery(orderId, 'picked_up');
      const kitchen = (await db().query(`SELECT lat, lng FROM pizzerias WHERE id=$1`, [v.pizzeriaId])).rows[0];
      const frames: number[] = [];
      const ctrl = new AbortController();
      const stream = fetch(`${API}/v1/orders/${orderId}/stream`, { signal: ctrl.signal }).then(async (res) => {
        const reader = res.body!.getReader();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += new TextDecoder().decode(value);
          for (const m of buf.split('\n\n').slice(0, -1)) {
            const json = m.split('\n').find((l) => l.startsWith('data: '));
            if (json) {
              const view = JSON.parse(json.slice(6));
              if (view.tracking) frames.push(view.tracking.progress);
            }
          }
          buf = buf.split('\n\n').at(-1)!;
        }
      });
      for (let i = 1; i <= 4; i++) {
        const t = i / 5;
        await staff.location(orderId, kitchen.lat + (HOME.lat - kitchen.lat) * t, kitchen.lng + (HOME.lng - kitchen.lng) * t);
        await sleep(700);
      }
      await staff.delivery(orderId, 'delivered');
      await Promise.race([stream, sleep(5000)]);
      ctrl.abort();
      assert.ok(frames.length >= 3, `got ${frames.length} live frames`);
      assert.ok(frames.at(-1)! > frames[0]!, 'progress increases');
      log(`Customer's stream received ${frames.length} live positions (progress ${frames.map((f) => f.toFixed(2)).join(' → ')}), then "delivered".`);
    },
  },
  {
    id: 's19',
    title: 'Phone: outbound call on order updates; a bad call opens a case; forged webhooks rejected',
    async run(log, people) {
      const c = await person('Tia');
      people.push(c);
      const r = await (staff as any).req('POST', '/v1/orders', {
        customer: { name: 'Tia', phone: c.opts.phone },
        delivery: HOME,
        items: [{ sku: 'margherita', qty: 1 }],
        channel: 'voice',
        notifyBy: ['call'],
      });
      await drive(r.orderId, 'preparing');
      const calls = await until(async () => {
        const x = (await db().query(`SELECT status FROM voice_calls WHERE direction='outbound' AND recipient=$1`, [`customer:${c.customerId}`])).rows;
        return x.length ? x : null;
      }, 8000, 'outbound call');
      log(`Order update placed as an ElevenLabs call (${calls[0].status}${calls[0].status === 'dry_run' ? ': no API key configured' : ''}).`);
      const body = JSON.stringify({
        type: 'post_call_transcription',
        data: { conversation_id: `conv_${Date.now()}`, analysis: { call_successful: 'failure', transcript_summary: 'Caller angry: pizza missing, wants refund' }, metadata: { phone_call: { external_number: c.opts.phone } } },
      });
      const secret = process.env.ELEVENLABS_WEBHOOK_SECRET ?? 'dev-elevenlabs-secret';
      const ok = await fetch(`${API}/v1/voice/elevenlabs/post-call`, { method: 'POST', headers: { 'content-type': 'application/json', 'elevenlabs-signature': signElevenLabs(body, secret) }, body }).then((x) => x.json() as Promise<any>);
      assert.ok(ok.caseId);
      const forged = await fetch(`${API}/v1/voice/elevenlabs/post-call`, { method: 'POST', headers: { 'content-type': 'application/json', 'elevenlabs-signature': signElevenLabs(body, 'wrong') }, body });
      assert.equal(forged.status, 401);
      log(`Failed call → support case ${ok.caseId} opened for the caller; forged signature → 401.`);
    },
  },
  {
    id: 's20',
    title: 'Customer revokes their assistant → it can no longer order for them',
    async run(log, people) {
      const c = await person('Uma');
      people.push(c);
      await c.say('I want 1 margherita, confirm');
      assert.ok(c.findInData((r) => r?.orderId), 'order placed while connected');
      const tok = (await db().query(`SELECT id FROM customer_tokens WHERE customer_id=$1 AND kind='assistant'`, [c.customerId])).rows[0].id;
      await db().query(`UPDATE customer_tokens SET revoked_at=now() WHERE id=$1`, [tok]);
      const r = await c.say('I want 1 margherita, confirm');
      assert.match(r.reply, /Sign in, or give a name and phone/);
      log(`After revoking, the same assistant asked again and was told: "${r.reply}"`);
    },
  },
  {
    id: 's21',
    title: 'One agent, any business: food, gym and mall offers in one conversation, each in its own theme',
    async run(log, people) {
      const c = await person('Vik', 'nearby', MALL);
      people.push(c);
      const themes = new Set<string>();
      for (const ask of ['find me a yoga class', 'get offers for 2 margherita', 'I want a flat white coffee']) {
        const r = await c.say(ask);
        for (const m of r.ui) if ('createSurface' in m) themes.add(JSON.stringify((m.createSurface.metadata as any)?.[THEME_METADATA_KEY] ?? {}));
        assert.ok(r.ui.length > 0, `UI for "${ask}"`);
        log(`"${ask}" → ${r.reply.slice(0, 110)}`);
      }
      assert.ok(themes.size >= 3, 'surfaces carry different provider themes');
      log(`${themes.size} distinct provider themes rendered by the same agent.`);
    },
  },
  {
    id: 's22',
    title: 'App button "call me back": the AI phones with the order in context and the call continues there',
    async run(log, people) {
      const c = await person('Wren');
      people.push(c);
      const orderId = await orderViaAgent(c, 'I want 1 margherita');
      await drive(orderId, 'preparing');
      const r = await sessionReq(c, 'POST', '/v1/me/callback', { timings: { debounceMs: 300, answerTimeoutMs: 20_000 } });
      const cb = await until(async () => {
        const x = await adminReq('GET', `/v1/callbacks/${r.callbackId}`);
        return x.status === 'calling' ? x : null;
      }, 15_000, 'call placed');
      assert.match(cb.context.opener, /about your order .* preparing/);
      log(`Tapped "Call me back". The agent dialled (ElevenLabs ${cb.conversationId.startsWith('dryrun') ? 'dry run' : 'live'}) and opened with: "${cb.context.opener}"`);
      const said = await voiceTurn(cb.id, 'where is my pizza?');
      assert.match(said, /preparing/);
      log(`Caller: "where is my pizza?" → agent: "${said}"`);
      await postCall(cb.conversationId, 'success', 'Customer asked about order status; answered.');
      await until(async () => ((await adminReq('GET', `/v1/callbacks/${cb.id}`)).status === 'completed' ? true : null), 8000, 'completed');
      log('Post-call webhook closed the callback as completed.');
    },
  },
  {
    id: 's23',
    title: 'Physical button, double press: "my usual" at the best competing price, confirmed by voice',
    async run(log, people) {
      const c = await person('Xia');
      people.push(c);
      const first = await orderViaAgent(c, 'I want 2 margherita and a lemonade');
      await drive(first, 'delivered');
      const btn = await sessionReq(c, 'POST', '/v1/me/buttons', { label: 'Fridge button', kind: 'physical' });
      log(`Registered a physical button; the device posts to ${btn.pressUrl.replace(API, '')}.`);
      const press = await fetch(`${API}/v1/buttons/${btn.id}/press`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-button-token': btn.token },
        body: JSON.stringify({ press: 'double', timings: { debounceMs: 300, answerTimeoutMs: 20_000 } }),
      }).then((x) => x.json() as Promise<any>);
      assert.equal(press.action, 'reorder');
      const cb = await until(async () => {
        const x = await adminReq('GET', `/v1/callbacks/${press.callbackId}`);
        return x.status === 'calling' ? x : null;
      }, 20_000, 'call placed');
      assert.ok(cb.live.offer, 'kitchens bid on the usual before the call');
      log(`Kitchens bid on the usual before dialling. Agent opened: "${cb.context.opener}"`);
      const said = await voiceTurn(cb.id, 'yes please');
      assert.match(said, /Ordered from/);
      assert.doesNotMatch(said, /ord_/, 'ids are never read out on the phone');
      const orderId = (await db().query(`SELECT id FROM orders WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 1`, [c.customerId])).rows[0].id as string;
      assert.notEqual(orderId, first);
      const v = await waitForOrder(orderId, ['payment_authorized']);
      assert.equal((await payment(orderId)).amount_cents, cb.live.offer.priceCents, 'charged the offered price');
      log(`Caller: "yes please" → "${said}" (routed to ${v.pizzeriaName}, exactly ${formatEur(cb.live.offer.priceCents)} authorized).`);
      await postCall(cb.conversationId, 'success', 'Reordered the usual.');
    },
  },
  {
    id: 's24',
    title: 'Button pressed five times in a row → one call, not five',
    async run(log, people) {
      const c = await person('Yan');
      people.push(c);
      const btn = await sessionReq(c, 'POST', '/v1/me/buttons', { label: 'Hall button', kind: 'physical' });
      const results: any[] = [];
      for (let i = 0; i < 5; i++) {
        results.push(
          await fetch(`${API}/v1/buttons/${btn.id}/press?token=${encodeURIComponent(btn.token)}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ timings: { debounceMs: 1500, answerTimeoutMs: 20_000 } }),
          }).then((x) => x.json()),
        );
      }
      assert.equal(new Set(results.map((r) => r.callbackId)).size, 1);
      const cb = await until(async () => {
        const x = await adminReq('GET', `/v1/callbacks/${results[0].callbackId}`);
        return x.status === 'calling' ? x : null;
      }, 15_000, 'call placed');
      const calls = (await db().query(`SELECT count(*)::int AS n FROM voice_calls WHERE conversation_id = $1`, [cb.conversationId])).rows[0].n;
      assert.equal(cb.presses, 5);
      assert.equal(calls, 1);
      log(`5 presses → 1 callback (${results.filter((r) => r.status === 'merged').length} merged) → 1 call.`);
      await postCall(cb.conversationId, 'success', 'ok');
    },
  },
  {
    id: 's25',
    title: 'Nobody answers → two retries → a text message instead',
    async run(log, people) {
      const c = await person('Zed');
      people.push(c);
      const r = await sessionReq(c, 'POST', '/v1/me/callback', { timings: { debounceMs: 200, maxAttempts: 3, retryDelayMs: 300, answerTimeoutMs: 600 } });
      const cb = await until(async () => {
        const x = await adminReq('GET', `/v1/callbacks/${r.callbackId}`);
        return x.status === 'unreachable' ? x : null;
      }, 20_000, 'unreachable');
      const sms = (await db().query(`SELECT message FROM notifications WHERE recipient=$1 AND channel='sms' ORDER BY id DESC LIMIT 1`, [`customer:${c.customerId}`])).rows[0];
      assert.equal(cb.attempts, 3);
      assert.match(sms.message, /tried to call you back/);
      log(`3 unanswered calls (minutes apart in production; 0.3 s here) → SMS: "${sms.message}"`);
    },
  },
  {
    id: 's26',
    title: 'Pressed during quiet hours → scheduled for morning; a long press cancels it',
    async run(log, people) {
      const c = await person('Ari');
      people.push(c);
      const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', hour: '2-digit', hourCycle: 'h23' }).format(new Date()));
      const btn = await sessionReq(c, 'POST', '/v1/me/buttons', { label: 'Bedside button', kind: 'physical', quietFrom: hour, quietTo: (hour + 1) % 24 });
      const press = (p: string) =>
        fetch(`${API}/v1/buttons/${btn.id}/press`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-button-token': btn.token }, body: JSON.stringify({ press: p, timings: { debounceMs: 200 } }) }).then(
          (x) => x.json() as Promise<any>,
        );
      const r = await press('single');
      const cb = await until(async () => {
        const x = await adminReq('GET', `/v1/callbacks/${r.callbackId}`);
        return x.status === 'scheduled' ? x : null;
      }, 10_000, 'scheduled');
      log(`Quiet hours ${hour}:00–${(hour + 1) % 24}:00 Berlin time: call scheduled for ${cb.scheduledFor.slice(11, 16)} UTC instead of now.`);
      const cancel = await press('long');
      assert.equal(cancel.status, 'cancelled');
      await until(async () => ((await adminReq('GET', `/v1/callbacks/${r.callbackId}`)).status === 'cancelled' ? true : null), 8000, 'cancelled');
      const calls = (await db().query(`SELECT count(*)::int AS n FROM voice_calls WHERE recipient=$1`, [`customer:${c.customerId}`])).rows[0].n;
      assert.equal(calls, 0);
      log('Long press cancelled it; no call was ever placed.');
    },
  },
  {
    id: 's27',
    title: 'Support misses its SLA → the AI calls the customer on its own',
    async run(log, people) {
      const c = await person('Bo');
      people.push(c);
      const orderId = await orderViaAgent(c, 'I want 5 night owl');
      await drive(orderId, 'delivered');
      const res = await fetch(`${API}/v1/support/cases`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${c.token}` },
        body: JSON.stringify({ message: 'all the wrong pizzas', orderId, timings: { approvalSlaMs: 500 } }),
      }).then((r) => r.json() as Promise<any>);
      const cb = await until(async () => (await db().query(`SELECT id, source FROM callbacks WHERE customer_id=$1`, [c.customerId])).rows[0] ?? null, 10_000, 'proactive callback');
      const live = await until(async () => {
        const x = await adminReq('GET', `/v1/callbacks/${cb.id}`);
        return x.status === 'calling' ? x : null;
      }, 15_000, 'calling');
      assert.match(live.context.opener, /support case/);
      log(`Case ${res.caseId} breached its SLA; the platform (${cb.source}) called the customer: "${live.context.opener}"`);
      await adminReq('POST', `/v1/support/cases/${res.caseId}/decision`, { approve: true });
      await postCall(live.conversationId, 'success', 'Apologised, refund approved.');
    },
  },
];

async function main() {
  const only = process.env.SCENARIO?.split(',');
  const results: Result[] = [];
  for (const s of scenarios.filter((x) => !only || only.includes(x.id))) {
    const happened: string[] = [];
    const people: DummyCustomer[] = [];
    const t0 = Date.now();
    try {
      await s.run((x) => happened.push(x), people);
      results.push({ id: s.id, title: s.title, ok: true, happened, ms: Date.now() - t0, transcript: people.flatMap((p) => p.transcript.map((t) => ({ from: t.from === 'customer' ? p.opts.name : 'agent', text: t.text }))) });
      console.log(`✔ ${s.id} ${s.title} (${Date.now() - t0} ms)`);
    } catch (err) {
      results.push({ id: s.id, title: s.title, ok: false, happened, error: (err as Error).message, ms: Date.now() - t0, transcript: people.flatMap((p) => p.transcript.map((t) => ({ from: p.opts.name, text: t.text }))) });
      console.log(`✘ ${s.id} ${s.title}: ${(err as Error).message}`);
    }
  }
  const dir = join(process.cwd(), 'reports');
  mkdirSync(dir, { recursive: true });
  const passed = results.filter((r) => r.ok).length;
  const md = [
    `# Problem scenarios — ${passed}/${results.length} passed`,
    '',
    `Run ${new Date().toISOString()} against ${API}. Customers are deep agents talking to the platform agent over A2A with A2UI.`,
    '',
    '| # | Scenario | Result | Time |',
    '| --- | --- | --- | --- |',
    ...results.map((r) => `| ${r.id} | ${r.title} | ${r.ok ? 'pass' : `FAIL: ${r.error}`} | ${(r.ms / 1000).toFixed(1)} s |`),
    '',
    ...results.flatMap((r) => [
      `## ${r.id}. ${r.title}`,
      '',
      ...r.happened.map((h) => `- ${h}`),
      ...(r.error ? [`- **Failed:** ${r.error}`] : []),
      '',
      ...(r.transcript.length ? ['<details><summary>Conversation</summary>', '', ...r.transcript.map((t) => `- **${t.from}:** ${t.text.replace(/\n/g, ' ')}`), '', '</details>', ''] : []),
    ]),
  ].join('\n');
  writeFileSync(join(dir, 'scenarios.md'), md);
  writeFileSync(join(dir, 'scenarios.json'), JSON.stringify(results, null, 2));
  console.log(`\n${passed}/${results.length} scenarios passed — reports/scenarios.md`);
  await closePool();
  if (passed !== results.length) process.exitCode = 1;
}

if (require.main === module) main();
