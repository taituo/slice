import { z } from 'zod';

/** Runtime validation for everything that crosses a trust boundary (HTTP, MCP, A2A, agent tool calls). */

export const geoPointSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

export const cartLineSchema = z.object({
  sku: z.string().min(1).max(64),
  qty: z.number().int().min(1).max(50),
});

export const placeOrderSchema = z.object({
  customer: z.object({
    name: z.string().min(1).max(120),
    phone: z.string().min(5).max(32),
    email: z.string().email().optional(),
    marketingConsent: z.boolean().optional(),
  }),
  delivery: geoPointSchema.extend({ addressLine: z.string().min(3).max(240) }),
  items: z.array(cartLineSchema).min(1).max(30),
  channel: z.enum(['web', 'mobile', 'xr', 'agent', 'mcp', 'a2a', 'phone', 'sms', 'voice']),
  notifyBy: z.array(z.enum(['sms', 'call', 'push', 'email'])).optional(),
  offerId: z.string().optional(),
  adId: z.string().optional(),
});

export const kitchenEventSchema = z.object({
  action: z.enum(['accept', 'ready', 'reject']),
  reason: z.string().max(200).optional(),
  pizzeriaId: z.string().optional(),
});

export const deliveryEventSchema = z.object({
  status: z.enum(['picked_up', 'delivered', 'failed']),
  reason: z.string().max(200).optional(),
});

export const cancelSchema = z.object({ reason: z.string().max(200).default('customer_request') });

export const pizzeriaUpsertSchema = z.object({
  brandId: z.string().min(1),
  name: z.string().min(1).max(120),
  region: z.string().min(2).max(64),
  address: z.string().min(3).max(240),
  lat: z.number(),
  lng: z.number(),
  deliveryMode: z.enum(['own_fleet', 'third_party']),
  capacityPer15Min: z.number().int().min(1).max(500),
  status: z.enum(['open', 'paused', 'closed']).default('open'),
});

export const menuItemUpsertSchema = z.object({
  sku: z.string().min(1).max(64),
  name: z.string().min(1).max(120),
  description: z.string().max(500),
  category: z.enum(['pizza', 'side', 'drink', 'dessert']),
  basePriceCents: z.number().int().min(0),
  tags: z.array(z.string()).default([]),
});

export const campaignUpsertSchema = z.object({
  code: z.string().min(2).max(40),
  name: z.string().min(1).max(120),
  percentOff: z.number().min(0).max(90),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
  regions: z.array(z.string()).nullable().default(null),
  skus: z.array(z.string()).nullable().default(null),
});

export type PlaceOrderBody = z.infer<typeof placeOrderSchema>;
