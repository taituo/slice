import { Client, Connection } from '@temporalio/client';

export const TEMPORAL_ADDRESS = process.env.TEMPORAL_ADDRESS ?? 'localhost:7233';
export const TEMPORAL_NAMESPACE = process.env.TEMPORAL_NAMESPACE ?? 'default';

/**
 * Task queues. Orders run on a per-region queue when REGIONAL_QUEUES=true, so a region's workers can
 * be scaled, canaried or kept in-country (data residency) independently. Ops work has its own queue.
 */
export const ORDERS_QUEUE = process.env.ORDERS_QUEUE ?? 'orders';
export const OPS_QUEUE = process.env.OPS_QUEUE ?? 'ops';

export function ordersQueueFor(region: string): string {
  if (process.env.REGIONAL_QUEUES !== 'true') return ORDERS_QUEUE;
  // 'de-berlin-mitte' → 'orders.de-berlin'
  return `${ORDERS_QUEUE}.${region.split('-').slice(0, 2).join('-')}`;
}

let client: Client | null = null;

export async function getTemporalClient(): Promise<Client> {
  if (!client) {
    const connection = await Connection.connect({ address: TEMPORAL_ADDRESS });
    client = new Client({ connection, namespace: TEMPORAL_NAMESPACE });
  }
  return client;
}
