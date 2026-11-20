/**
 * End-to-end check against a running stack (API + worker + Temporal + Postgres [+ MCP]).
 *   npm run e2e
 * Plays customer, kitchen and courier through the real REST API and Temporal workflows.
 */
import assert from 'node:assert/strict';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SliceApiError, SliceClient, type OrderStatus } from '@slice/shared';
import { getTemporalClient, OPS_QUEUE } from '@slice/workflows';
import { closePool, getPool } from '@slice/db';

const API = process.env.API_URL ?? 'http://localhost:4000';
const MCP = process.env.MCP_URL ?? 'http://localhost:4100/mcp';
const customer = new SliceClient(API);
const staff = new SliceClient(API, { partnerKey: process.env.PARTNER_API_KEY ?? 'dev-partner-key', adminKey: process.env.ADMIN_API_KEY ?? 'dev-admin-key' });

// Rosenthaler Platz, Berlin-Mitte
const home = { lat: 52.5302, lng: 13.4011, addressLine: 'Weinbergsweg 3, 10119 Berlin' };

let passed = 0;
async function step(name: string, fn: () => Promise<void>) {
  const t0 = Date.now();
  await fn();
  passed++;
  console.log(`✔ ${name} (${Date.now() - t0} ms)`);
}

async function waitFor(orderId: string, statuses: OrderStatus[], timeoutMs = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = await customer.order(orderId);
    if (statuses.includes(v.status)) return v;
    await new Promise((r) => setTimeout(r, 150));
  }
  const v = await customer.order(orderId);
  throw new Error(`Timed out waiting for ${statuses.join('|')}; order is ${v.status}`);
}

async function main() {
  await step('health', async () => {
    const res = await fetch(`${API}/health`);
    assert.equal(res.status, 200);
  });

  let nearestId = '';
  await step('nearest pizzeria from Rosenthaler Platz is the original Mitte kitchen', async () => {
    const { pizzerias } = await customer.nearest(home.lat, home.lng, 3);
    assert.ok(pizzerias.length >= 2);
    assert.equal(pizzerias[0]!.id, 'ber-mitte-01');
    assert.ok(pizzerias.every((p) => p.status === 'open'), 'paused kitchens are excluded');
    nearestId = pizzerias[0]!.id;
  });

  await step('quote applies the active campaign', async () => {
    const { quote } = await customer.quote(home.lat, home.lng, [{ sku: 'margherita', qty: 2 }, { sku: 'lemonade', qty: 1 }]);
    assert.equal(quote.subtotalCents, 2 * 950 + 390);
    assert.equal(quote.totalCents, quote.subtotalCents - quote.discountCents + quote.deliveryFeeCents);
    console.log(`   quote: ${JSON.stringify({ total: quote.totalCents, campaign: quote.campaignCode, variant: quote.experimentVariant })}`);
  });

  const order = { customer: { name: 'Ada Example', phone: '+49 151 0000 0001', marketingConsent: true }, delivery: home, items: [{ sku: 'margherita', qty: 2 }, { sku: 'diavola', qty: 1 }], channel: 'web' as const, notifyBy: ['sms' as const] };
  let orderId = '';
  await step('place order is idempotent', async () => {
    const key = `e2e-${Date.now()}`;
    const a = await customer.placeOrder(order, key);
    const b = await customer.placeOrder(order, key);
    assert.equal(a.orderId, b.orderId);
    orderId = a.orderId;
  });

  let firstKitchen = '';
  await step('order is routed to the nearest kitchen and payment authorized', async () => {
    const v = await waitFor(orderId, ['payment_authorized']);
    assert.equal(v.pizzeriaId, nearestId);
    assert.ok(v.quote && v.quote.totalCents > 0);
    firstKitchen = v.pizzeriaId!;
  });

  await step('kitchen rejects → order reroutes to the next-closest pizzeria', async () => {
    await staff.kitchen(orderId, 'reject', 'oven maintenance', firstKitchen);
    const t0 = Date.now();
    let v = await customer.order(orderId);
    while ((v.pizzeriaId === firstKitchen || v.status !== 'routed') && Date.now() - t0 < 10000) {
      await new Promise((r) => setTimeout(r, 150));
      v = await customer.order(orderId);
    }
    assert.notEqual(v.pizzeriaId, firstKitchen);
    assert.deepEqual(v.attemptedPizzerias.slice(0, 1), [firstKitchen]);
    assert.ok(v.timeline.some((e) => e.type === 'rerouted'));
    console.log(`   rerouted ${firstKitchen} → ${v.pizzeriaId}`);
  });

  await step('stale signal from the rejected kitchen is ignored', async () => {
    await staff.kitchen(orderId, 'accept', undefined, firstKitchen);
    await new Promise((r) => setTimeout(r, 500));
    const v = await customer.order(orderId);
    assert.equal(v.status, 'routed');
  });

  await step('kitchen → courier → delivered, payment captured', async () => {
    const v0 = await customer.order(orderId);
    await staff.kitchen(orderId, 'accept', undefined, v0.pizzeriaId!);
    await waitFor(orderId, ['preparing']);
    await staff.kitchen(orderId, 'ready', undefined, v0.pizzeriaId!);
    await waitFor(orderId, ['ready']);
    // Wait until the courier has been dispatched before the pickup scan.
    const t0 = Date.now();
    while (!(await customer.order(orderId)).delivery && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 100));
    await staff.delivery(orderId, 'picked_up');
    await waitFor(orderId, ['out_for_delivery']);
    await staff.delivery(orderId, 'delivered');
    const v = await waitFor(orderId, ['delivered']);
    const pay = await getPool().query(`SELECT status FROM payments WHERE order_id=$1`, [orderId]);
    assert.equal(pay.rows[0]?.status, 'captured');
    const db = await getPool().query(`SELECT status FROM orders WHERE id=$1`, [orderId]);
    assert.equal(db.rows[0]?.status, 'delivered');
    console.log(`   timeline: ${v.timeline.map((e) => e.type).join(' → ')}`);
  });

  await step('cancel before pickup voids the payment', async () => {
    const { orderId: id } = await customer.placeOrder({ ...order, items: [{ sku: 'funghi', qty: 1 }] });
    const v = await waitFor(id, ['payment_authorized']);
    await staff.kitchen(id, 'accept', undefined, v.pizzeriaId!);
    await waitFor(id, ['preparing']);
    await customer.cancel(id, 'changed my mind');
    const done = await waitFor(id, ['cancelled']);
    assert.equal(done.failureReason, 'changed my mind');
    const pay = await getPool().query(`SELECT status FROM payments WHERE order_id=$1`, [id]);
    assert.equal(pay.rows[0]?.status, 'voided');
  });

  await step('declined card fails the order cleanly', async () => {
    const { orderId: id } = await customer.placeOrder({ ...order, items: [{ sku: 'night-owl', qty: 40 }] });
    const v = await waitFor(id, ['failed']);
    assert.equal(v.failureReason, 'PaymentDeclined');
  });

  await step('outside the delivery area → 422', async () => {
    await assert.rejects(
      customer.placeOrder({ ...order, delivery: { lat: 48.1351, lng: 11.582, addressLine: 'Marienplatz, München' } }),
      (e: unknown) => e instanceof SliceApiError && e.status === 422,
    );
  });

  await step('admin CRUD requires a key and works with one', async () => {
    const res = await fetch(`${API}/v1/menu/test-pizza`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(res.status, 401);
    const ok = await fetch(`${API}/v1/menu/truffle`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-admin-key': 'dev-admin-key' },
      body: JSON.stringify({ name: 'Truffle', description: 'Seasonal', category: 'pizza', basePriceCents: 1890, tags: ['seasonal'] }),
    });
    assert.equal(ok.status, 200);
    const del = await fetch(`${API}/v1/menu/truffle`, { method: 'DELETE', headers: { 'x-admin-key': 'dev-admin-key' } });
    assert.equal(del.status, 204);
  });

  await step('in-app agent answers menu, nearest and quote intents', async () => {
    const ctx = { location: home };
    const m = await customer.agentChat([{ role: 'user', content: 'Do you have anything vegan?' }], ctx);
    assert.match(m.reply, /Bloom Garden/);
    const n = await customer.agentChat([{ role: 'user', content: "What's the nearest pizzeria?" }], ctx);
    assert.match(n.reply, /Slice Mitte/);
    const q = await customer.agentChat([{ role: 'user', content: 'I want 2 margherita and a tiramisu' }], ctx);
    assert.match(q.reply, /confirm/);
    console.log(`   [${q.engine}] ${q.reply}`);
  });

  await step('A2A: agent card + structured tool call', async () => {
    const card: any = await (await fetch(`${API}/.well-known/agent-card.json`)).json();
    assert.ok(card.skills.some((s: { id: string }) => s.id === 'place_order'));
    const rpc: any = await (
      await fetch(`${API}/a2a`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'message/send',
          params: { message: { role: 'user', messageId: 'm1', parts: [{ kind: 'data', data: { tool: 'find_nearest_pizzeria', args: { lat: home.lat, lng: home.lng, limit: 1 } } }] } },
        }),
      })
    ).json();
    assert.equal(rpc.result.parts[0].data.result[0].id, 'ber-mitte-01');
  });

  await step('MCP: tools listed and callable over Streamable HTTP', async () => {
    const mcp = new McpClient({ name: 'e2e', version: '1.0.0' });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(MCP)));
    const { tools } = await mcp.listTools();
    assert.ok(tools.map((t) => t.name).includes('place_order'));
    const res = (await mcp.callTool({ name: 'find_nearest_pizzeria', arguments: { lat: home.lat, lng: home.lng, limit: 1 } })) as {
      content: Array<{ type: string; text: string }>;
    };
    assert.equal(JSON.parse(res.content[0]!.text).data[0].id, 'ber-mitte-01');
    await mcp.close();
  });

  await step('connect your assistant: phone code → assistant token → MCP orders without asking name or phone', async () => {
    const phone = `+49151${Date.now().toString().slice(-7)}`;
    const start: any = await (await fetch(`${API}/v1/auth/otp/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone }) })).json();
    const v: any = await (await fetch(`${API}/v1/auth/otp/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone, code: start.devCode }) })).json();
    const asst: any = await (await fetch(`${API}/v1/me/assistants`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${v.token}` }, body: JSON.stringify({ label: 'My ChatGPT', scopes: ['browse', 'order'] }) })).json();
    const mcp = new McpClient({ name: 'e2e-assistant', version: '1.0.0' });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(MCP), { requestInit: { headers: { authorization: `Bearer ${asst.token}` } } }));
    const res = (await mcp.callTool({ name: 'place_order', arguments: { addressLine: home.addressLine, lat: home.lat, lng: home.lng, items: [{ sku: 'margherita', qty: 1 }] } })) as { content: Array<{ text: string }> };
    const placed = JSON.parse(res.content[0]!.text);
    assert.match(placed.data.orderId, /^ord_/);
    const denied = (await mcp.callTool({ name: 'open_support_case', arguments: { message: 'test scope' } })) as { isError?: boolean };
    assert.ok(denied.isError, 'support scope not granted to this assistant');
    await mcp.close();
    console.log(`   assistant ordered ${placed.data.orderId}; out-of-scope tool refused`);
  });

  await step('A2A with A2UI + durable async task (tasks/get)', async () => {
    const send = async (params: unknown, ext = true) =>
      (await fetch(`${API}/t/nearby/a2a`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(ext ? { 'x-a2a-extensions': 'https://a2ui.org/a2a-extension/a2ui/v1.0' } : {}) },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: params && (params as any).method ? (params as any).method : 'message/send', params }),
      }).then((r) => r.json())) as any;
    const sync = await send({ message: { role: 'user', messageId: 'a', parts: [{ kind: 'text', text: 'I need running shoes' }] }, metadata: { location: { lat: 52.5106, lng: 13.3807 } } });
    const ui = sync.result.parts.find((p: any) => p.metadata?.mimeType === 'application/a2ui+json');
    assert.ok(ui && ui.data.some((m: any) => m.createSurface), 'A2UI surfaces returned');
    const task = await send({ message: { role: 'user', messageId: 'b', parts: [{ kind: 'text', text: 'show me the menu' }] }, configuration: { blocking: false } });
    assert.equal(task.result.kind, 'task');
    let state = '';
    for (let i = 0; i < 40 && state !== 'completed'; i++) {
      await new Promise((r) => setTimeout(r, 150));
      const got = await (await fetch(`${API}/t/nearby/a2a`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tasks/get', params: { id: task.result.id } }) })).json() as any;
      state = got.result?.status?.state;
    }
    assert.equal(state, 'completed');
  });

  await step('voice: ElevenLabs custom-LLM endpoint is the same agent; server tool webhook works', async () => {
    const llm: any = await (await fetch(`${API}/v1/voice/llm/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer dev-voice-llm-key' },
      body: JSON.stringify({ messages: [{ role: 'system', content: 'x' }, { role: 'user', content: 'do you have anything vegan?' }], user: `call-${Date.now()}` }),
    })).json();
    assert.match(llm.choices[0].message.content, /Bloom Garden/);
    const tool: any = await (await fetch(`${API}/v1/voice/tools/find_nearest_pizzeria`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-voice-secret': 'dev-voice-secret' },
      body: JSON.stringify({ lat: home.lat, lng: home.lng, limit: 1 }),
    })).json();
    assert.match(tool.result, /Slice Mitte/);
  });

  await step('ads: generated from live specials/capacity, served by Thompson sampling, click + conversion counted', async () => {
    const run: any = await (await fetch(`${API}/v1/admin/ads/run`, { method: 'POST', headers: { 'x-admin-key': 'dev-admin-key' } })).json();
    assert.ok(run.created + run.total > 0);
    const served: any = await (await fetch(`${API}/v1/ads?tenant=nearby&lat=${home.lat}&lng=${home.lng}`)).json();
    assert.ok(served.ad, 'an ad was served');
    await fetch(`${API}/v1/ads/${served.ad.id}/click`, { method: 'POST' });
    await customer.placeOrder({ ...order, items: [{ sku: 'margherita', qty: 1 }], adId: served.ad.id });
    const all: any = await (await fetch(`${API}/v1/admin/ads`, { headers: { 'x-admin-key': 'dev-admin-key' } })).json();
    const ad = all.ads.find((a: any) => a.id === served.ad.id);
    assert.ok(ad.impressions >= 1 && ad.clicks >= 1 && ad.conversions >= 1);
    console.log(`   ${run.created} ads created (${run.rejected} copy variants rejected by guardrails); served "${served.ad.headline}"`);
  });

  await step('GDPR export then erasure', async () => {
    const { rows } = await getPool().query(`SELECT customer_id FROM orders WHERE id=$1`, [orderId]);
    const id = rows[0].customer_id as string;
    const exp: any = await (await fetch(`${API}/v1/customers/${id}/export`, { headers: { 'x-admin-key': 'dev-admin-key' } })).json();
    assert.equal(exp.customer.name, 'Ada Example');
    const raw = await getPool().query(`SELECT name_enc FROM customer_pii WHERE customer_id=$1`, [id]);
    assert.ok(!Buffer.from(raw.rows[0].name_enc).toString('utf8').includes('Ada'), 'PII is encrypted at rest');
    const del = await fetch(`${API}/v1/customers/${id}`, { method: 'DELETE', headers: { 'x-admin-key': 'dev-admin-key' } });
    assert.equal(del.status, 204);
    const after: any = await (await fetch(`${API}/v1/customers/${id}/export`, { headers: { 'x-admin-key': 'dev-admin-key' } })).json();
    assert.equal(after.customer.name, null);
    const o = await getPool().query(`SELECT count(*)::int AS n FROM orders WHERE customer_id=$1`, [id]);
    assert.ok(o.rows[0].n >= 1, 'pseudonymous order history kept');
  });

  await step('ops workflows: weekly review, inventory reorder, usage → issues', async () => {
    const client = await getTemporalClient();
    for (let i = 0; i < 3; i++) await customer.signal('unhandled_intent', { theme: 'gluten-free-base', request: 'gluten free?' });
    await getPool().query(`UPDATE inventory SET qty = 10 WHERE pizzeria_id='ber-kotti-03' AND ingredient='dough'`); // below threshold
    const review = await client.workflow.execute('weeklyOpsReviewWorkflow', { taskQueue: OPS_QUEUE, workflowId: `e2e-ops-${Date.now()}` });
    const inv = await client.workflow.execute('inventoryReorderWorkflow', { taskQueue: OPS_QUEUE, workflowId: `e2e-inv-${Date.now()}` });
    const fb = await client.workflow.execute('productFeedbackWorkflow', { taskQueue: OPS_QUEUE, workflowId: `e2e-fb-${Date.now()}`, args: [{ minOccurrences: 3 }] });
    console.log(`   ops: ${JSON.stringify({ reviewed: (review as any).reviewed, calls: (review as any).callsBooked, reordered: (inv as any).reordered, issues: (fb as any).issues.map((i: any) => i.key) })}`);
    assert.ok((inv as any).reordered >= 1, 'low dough at Night Owl Kotti triggers a reorder');
    assert.ok((fb as any).issues.some((i: any) => i.key.includes('gluten-free-base')));
    console.log('   dev agent drafted the issue (problem, files, flag, tests, rollout)');
  });

  console.log(`\nAll ${passed} checks passed.`);
  const client = await getTemporalClient();
  await client.connection.close();
  await closePool();
}

main().catch(async (err) => {
  console.error('✘', err);
  await closePool();
  process.exit(1);
});
