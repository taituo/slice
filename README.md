# Slice — one agent platform for any local business

It started as a pizzeria franchise in Berlin-Mitte: ten kitchens, three brands (Slice Network, plus
the virtual brands Night Owl Pizza and Basil & Bloom). The same platform now also runs a gym chain
(FlexGym) and an unbranded "Nearby" service. With Nearby, the shops around a shopper's GPS position
(for example inside a mall, with no mall integration) compete with offers in real time.

**Same agent, same workflows, any business.** Customers talk to one deep agent: in the web chat,
from their own assistant (ChatGPT/Claude over MCP, or any agent over A2A), or on the phone through
ElevenLabs. The agent answers with A2UI surfaces skinned in each provider's theme. Orders,
bookings, vouchers, support cases and ads are durable Temporal workflows on Postgres.

```
 people & their assistants
   web chat (A2UI) · ChatGPT / Claude (MCP) · other agents (A2A + A2UI) · phone (ElevenLabs)
        │                    │                         │                       │
        ▼                    ▼                         ▼                       ▼
 ┌─────────────────────── deep agent per tenant (packages/agents) ───────────────────────┐
 │ concierge → plans (write_todos), delegates to specialists: food · fitness · retail · support │
 │ memory per conversation (any channel) · DeepSeek/any OpenAI-compatible LLM · offline rules   │
 └───────────────────────────────┬──────────────────────────────────────────────────────┘
                                 │ one tool catalogue (packages/shared/src/tools.ts)
                                 ▼
 API (Fastify) ── offers · orders · bookings · vouchers · support · ads · identity · voice · SSE tracking
        │ start / signal / query                                        │ SQL
        ▼                                                               ▼
 Temporal ── orderWorkflow · offerAuctionWorkflow · classBookingWorkflow    Postgres ── tenants, providers,
            supportCaseWorkflow · voucherWorkflow · adOptimizerWorkflow            orders, offers, bookings,
            agentTaskWorkflow (A2A async) · ops reviews · dev-agent loop           cases, ads, PII encrypted
```

## What's in it

| Capability | How it works |
| --- | --- |
| **Competing offers** | `offerAuctionWorkflow` asks every provider in range (kitchens for a cart, gyms for a class, shops for a product) in parallel within a time window. Providers with a `match`/`beat` policy counter-bid in a second round, never below their private floor. Ranked by best value, cheapest, fastest or closest. A provider can answer through its own A2A agent; if that agent is down, its standing policy answers instead. |
| **Specials** | Time-boxed per-provider deals (% off, € off, free item) plus "ovens free now" discounts when a kitchen is idle. Full kitchens don't bid. |
| **Mall mode** | Retail merchants are placed by GPS; a shopper's position is enough. Winning offers become 30-minute vouchers the shop redeems once. |
| **One agent, any business** | `conciergeFor(tenant)` composes specialists for the tenant's verticals. Branded tenants speak as the brand; `nearby` is white-label. |
| **A2UI** | Agents return A2UI v1.0 surfaces (`createSurface` + `updateComponents`). Each surface carries its provider's theme in `metadata["slice.theme"]`, so a sneaker shop, a gym and a pizzeria each look like themselves. Button presses come back as A2UI `action` events and run the named tool directly. |
| **A2A** | `/t/<tenant>/.well-known/agent-card.json` and `/t/<tenant>/a2a`: text, structured tool calls, A2UI in and out (when the client sends `X-A2A-Extensions`), and `blocking:false` durable tasks polled with `tasks/get`. |
| **Connect your assistant** | Phone code sign-in → `sk_asst_…` tokens with scopes (browse/order/track/support), revocable. MCP and A2A calls with the token act for that person: no name or phone needed, and calls outside the token's scopes are refused. |
| **Voice (ElevenLabs)** | Our agent is the ElevenLabs agent's custom LLM (OpenAI-compatible endpoint), or the ElevenLabs agent calls our server tools. Outbound calls for order updates and reminders. A signed post-call webhook opens support cases. See `integrations/elevenlabs/`. |
| **Support** | `supportCaseWorkflow`: triage, then a written policy. Late over 60 min or failed order: €5 credit. Missing or wrong item: 40% refund up to €15. Quality problem: 30% up to €10. Anything larger goes to a person with an approval SLA; a missed SLA pages the duty lead. A CSAT follow-up comes afterwards. |
| **Live tracking** | Couriers send GPS pings as `courierLocation` signals. The order workflow keeps position, remaining km and ETA, and `GET /v1/orders/:id/stream` pushes changes over SSE. |
| **Generated ads** | `adOptimizerWorkflow` writes ads for what's true now: active specials, idle kitchens, classes with free spots. Copy comes from the LLM or templates. Guardrails reject unbacked "% off" claims and superlatives. Variants are served by Thompson sampling, and losers are paused. Clicks and conversions are attributed. |
| **Gyms** | `classBookingWorkflow`: confirm or waitlist, automatic promotion when someone cancels, reminder, check-in, no-show. |
| **Deep agents for development** | The same runtime powers a development agent. Clusters of real usage signals (unmet requests, errors) become GitHub issues with problem, files, feature flag, tests and rollout, which `bot-dev.yml` hands to a coding agent. |

## Run it

```bash
npm install
temporal server start-dev                 # Temporal on :7233
npm run db:seed -- --reset                # schema + Berlin pizzerias, gyms, mall shops, specials
npm run dev:worker                        # Temporal worker
npm run dev:api                           # API on :4000
npm run dev:mcp                           # MCP on :4100/mcp
npm run dev:web                           # storefront on :5173, live load map on :5173/?view=map
npm run simulate                          # optional: kitchens & couriers (with GPS) for live orders
npm run schedules                         # weekly ops review, reorders, feedback loop, campaigns
```

`docker compose up --build` runs everything. The compose file is validated; the tested path is the local one above.

## Test it

| Command | What it proves | Last result |
| --- | --- | --- |
| `TEMPORAL_CLI_PATH=$(which temporal) npm test` | Pricing, offers and counter-bids, A2UI validity, ad sampling and guardrails, deep-agent runtime (plan, delegate, memory, actions, fallback), and order, auction, booking and support workflows on a real Temporal server | 27 / 27 |
| `npm run e2e` | 21 checks through the real API: routing, rerouting, payments, cancellation, GDPR, MCP with an assistant token, A2A + A2UI + async tasks, voice endpoints, ads | 21 / 21 |
| `npm run scenarios` | **21 problem scenarios** played by dummy customer agents over A2A: refunds, credits, approvals, SLA breach, reroutes, declined card, courier crash, voucher expiry, waitlist, no-show, live tracking, phone call, revoked assistant… | 21 / 21, see `reports/scenarios.md` |
| `npm run load` | People on a map: diners, mall shoppers, gym-goers walking around Berlin, each a deep agent with its own token, plus kitchens and couriers | see `reports/load*.md` |

Load test knobs: `PEOPLE`, `DURATION_S`, `THINK_MS`, `SEED`. Open `/?view=map` while it runs.

## Map of the code

| Path | What it is |
| --- | --- |
| `packages/shared` | Types, schemas, pricing, offers engine, A2UI builders, ads sampling + guardrails, tool catalogue, `SliceClient` |
| `packages/agents` | Deep-agent runtime: planning, sub-agents, memory, A2UI actions, offline fallbacks, OpenAI-compatible LLM client |
| `packages/db` | Migrations (`001_core`, `002_platform`), repositories, seeds (incl. 10k-site scale seed) |
| `packages/workflows` | All Temporal workflows and activities; adapters for payments, delivery, notify, voice (ElevenLabs), GitHub |
| `packages/api` | REST API, per-tenant agents and tools, A2A, voice endpoints, SSE tracking, identity |
| `packages/mcp` | MCP server (Streamable HTTP + stdio) over the same tool catalogue |
| `packages/sim` | Dummy customer agents, kitchen/courier actors, scenarios, load generator |
| `apps/web` | Storefront: competing offers, live tracking, A2UI chat across tenants, ad slot, live load map |
| `integrations/elevenlabs` | Voice setup guide and generated server-tool definitions |

## What's real and what's simulated

Real: workflows, auctions, routing with capacity locks, pricing, support policy, A2A/A2UI/MCP,
assistant tokens, SSE tracking, ad generation and serving, encrypted PII, the deep-agent loop
(with an LLM key; deterministic rules without one).

Simulated behind interfaces: payments (`FakePay`, declines over €500), couriers and the delivery
partner, SMS/push, supplier orders, GitHub issues without a token, and ElevenLabs calls without
keys (logged as `dry_run`). Staff and partner auth use static development keys.
