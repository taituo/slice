import { ScheduleAlreadyRunning, ScheduleOverlapPolicy, WorkflowExecutionAlreadyStartedError } from '@temporalio/client';
import { closePool, listCampaigns } from '@slice/db';
import { getTemporalClient, OPS_QUEUE } from './temporal';

/** Registers the recurring business processes as Temporal Schedules (idempotent). */
async function main() {
  const client = await getTemporalClient();
  const tz = process.env.OPS_TIMEZONE ?? 'Europe/Berlin';

  const schedules = [
    { id: 'weekly-ops-review', workflowType: 'weeklyOpsReviewWorkflow', cron: '0 9 * * MON', args: [] as unknown[] },
    { id: 'inventory-reorder', workflowType: 'inventoryReorderWorkflow', cron: '15 * * * *', args: [] },
    { id: 'product-feedback', workflowType: 'productFeedbackWorkflow', cron: '0 6 * * *', args: [{ minOccurrences: 3 }] },
  ];

  for (const s of schedules) {
    try {
      await client.schedule.create({
        scheduleId: s.id,
        spec: { cronExpressions: [s.cron], timezone: tz },
        action: { type: 'startWorkflow', workflowType: s.workflowType, args: s.args, taskQueue: OPS_QUEUE },
        policies: { overlap: ScheduleOverlapPolicy.SKIP },
      });
      console.log(`Created schedule ${s.id} (${s.cron} ${tz})`);
    } catch (err) {
      if (err instanceof ScheduleAlreadyRunning) console.log(`Schedule ${s.id} already exists`);
      else throw err;
    }
  }

  // One durable lifecycle workflow per campaign that hasn't ended yet.
  const now = Date.now();
  for (const c of await listCampaigns()) {
    if (Date.parse(c.endsAt) <= now) continue;
    try {
      await client.workflow.start('campaignLifecycleWorkflow', {
        workflowId: `campaign-${c.code}`,
        taskQueue: OPS_QUEUE,
        args: [{ code: c.code, startsAt: c.startsAt, endsAt: c.endsAt }],
      });
      console.log(`Started campaign workflow ${c.code}`);
    } catch (err) {
      if (err instanceof WorkflowExecutionAlreadyStartedError) console.log(`Campaign ${c.code} already scheduled`);
      else throw err;
    }
  }
  await client.connection.close();
  await closePool();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
