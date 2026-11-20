import { z } from 'zod';
import { cartLineSchema } from './schemas';

/**
 * One tool catalogue for every vertical and every door: the in-app/concierge agent (DeepSeek),
 * the MCP server, A2A, and the ElevenLabs voice agent. Each tool belongs to a domain; a tenant
 * exposes the domains of its verticals plus the platform domains (offers, support).
 */
export type ToolDomain = 'food' | 'fitness' | 'retail' | 'offers' | 'support';

const geo = { lat: z.number().describe('Latitude'), lng: z.number().describe('Longitude') };
const person = {
  name: z.string().optional().describe('Customer name (not needed when the customer is signed in)'),
  phone: z.string().optional().describe('Phone in international format (not needed when signed in)'),
};

export const toolCatalog = {
  // ---------------------------------------------------------------- platform: competing offers
  request_offers: {
    domain: 'offers',
    description:
      'Ask every provider near a location to compete with an offer: pizzerias for a cart, gyms for a class, shops for a product (works inside a mall from GPS alone). Returns ranked offers.',
    input: z.object({
      vertical: z.enum(['food', 'fitness', 'retail']),
      ...geo,
      query: z.string().optional().describe('What the customer wants, e.g. "running shoes", "yoga", "coffee"'),
      items: z.array(cartLineSchema).optional().describe('Food only: cart lines'),
      preference: z.enum(['best_value', 'cheapest', 'fastest', 'closest']).optional(),
    }),
  },
  choose_offer: {
    domain: 'offers',
    description:
      'Accept one offer: places the food order, books the class, or issues a shop voucher. Confirm the offer with the customer first.',
    input: z.object({
      offerId: z.string(),
      ...person,
      addressLine: z.string().optional().describe('Food only: delivery address'),
    }),
  },
  // ---------------------------------------------------------------- food
  find_nearest_pizzeria: {
    domain: 'food',
    description: 'Find the open pizzerias closest to a location, with distance, current load and delivery ETA.',
    input: z.object({ ...geo, limit: z.number().int().min(1).max(10).optional() }),
  },
  get_menu: {
    domain: 'food',
    description: 'List menu items with SKU, price and tags (vegan, spicy, seasonal...).',
    input: z.object({}),
  },
  quote_order: {
    domain: 'food',
    description: 'Price a cart for a delivery location, including campaigns and delivery fee, without ordering.',
    input: z.object({ ...geo, items: z.array(cartLineSchema).min(1) }),
  },
  place_order: {
    domain: 'food',
    description:
      'Place a delivery order routed to the nearest pizzeria with capacity. Confirm items, address and total first.',
    input: z.object({
      ...person,
      addressLine: z.string().describe('Street address'),
      ...geo,
      items: z.array(cartLineSchema).min(1),
      notifyBy: z.array(z.enum(['sms', 'call', 'push', 'email'])).optional(),
    }),
  },
  order_status: {
    domain: 'food',
    description: 'Live status of an order, including courier position and ETA once it is on the way.',
    input: z.object({ orderId: z.string() }),
  },
  cancel_order: {
    domain: 'food',
    description: 'Cancel an order before pickup. Payment is released automatically.',
    input: z.object({ orderId: z.string(), reason: z.string().optional() }),
  },
  // ---------------------------------------------------------------- fitness
  find_classes: {
    domain: 'fitness',
    description: 'Upcoming classes at nearby gyms with free spots and price.',
    input: z.object({
      ...geo,
      kind: z.string().optional().describe('yoga, spin, hiit, strength'),
      withinHours: z.number().int().min(1).max(168).optional(),
    }),
  },
  book_class: {
    domain: 'fitness',
    description: 'Book a class. Full classes put the customer on the waitlist; a freed spot is given automatically.',
    input: z.object({ classId: z.string(), ...person }),
  },
  cancel_booking: {
    domain: 'fitness',
    description: 'Cancel a class booking; the first person on the waitlist gets the spot.',
    input: z.object({ bookingId: z.string() }),
  },
  booking_status: {
    domain: 'fitness',
    description: 'Status of a class booking (confirmed, waitlisted, attended...).',
    input: z.object({ bookingId: z.string() }),
  },
  // ---------------------------------------------------------------- retail
  find_nearby_shops: {
    domain: 'retail',
    description: 'Shops around a GPS point (e.g. inside a mall) and what they sell. No mall integration needed.',
    input: z.object({ ...geo, radiusM: z.number().int().min(20).max(3000).optional(), category: z.string().optional() }),
  },
  // ---------------------------------------------------------------- support
  open_support_case: {
    domain: 'support',
    description:
      'Open a support case (late, missing or wrong item, quality, booking or voucher problem). Small issues are resolved automatically.',
    input: z.object({ message: z.string().min(3), orderId: z.string().optional() }),
  },
  support_case_status: {
    domain: 'support',
    description: 'Status and resolution of a support case.',
    input: z.object({ caseId: z.string() }),
  },
} as const;

export type AgentToolName = keyof typeof toolCatalog;
export type AgentToolArgs<K extends AgentToolName> = z.infer<(typeof toolCatalog)[K]['input']>;

/** Back-compat alias. */
export const agentTools = toolCatalog;

export function toolsFor(domains: readonly ToolDomain[]): AgentToolName[] {
  return (Object.keys(toolCatalog) as AgentToolName[]).filter((n) => domains.includes(toolCatalog[n].domain));
}

/** JSON Schema form for OpenAI-compatible function calling (DeepSeek) and ElevenLabs server tools. */
export function toolJsonSchema(name: AgentToolName) {
  return z.toJSONSchema(toolCatalog[name].input, { target: 'draft-7' });
}

export function toolsAsJsonSchema(names: AgentToolName[] = Object.keys(toolCatalog) as AgentToolName[]) {
  return names.map((name) => ({
    type: 'function' as const,
    function: { name, description: toolCatalog[name].description, parameters: toolJsonSchema(name) },
  }));
}
