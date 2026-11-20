import { bundleWorkflowCode, NativeConnection, Worker } from '@temporalio/worker';
import { closePool } from '@slice/db';
import { createActivities } from './activities';
import { OPS_QUEUE, ORDERS_QUEUE, TEMPORAL_ADDRESS, TEMPORAL_NAMESPACE } from './temporal';

/**
 * One process, two workers: order orchestration and back-office ops. In production they are separate
 * deployments so a Christmas-eve order spike never waits behind an inventory sweep.
 * WORKER_QUEUES=orders.de-berlin lets a pod serve exactly one region.
 */
async function main() {
  const connection = await NativeConnection.connect({ address: TEMPORAL_ADDRESS });
  const activities = createActivities();
  const workflowBundle = await bundleWorkflowCode({ workflowsPath: require.resolve('./workflows') });
  const queues = (process.env.WORKER_QUEUES ?? `${ORDERS_QUEUE},${OPS_QUEUE}`).split(',').map((q) => q.trim());
  const workers = await Promise.all(
    queues.map((taskQueue) =>
      Worker.create({
        connection,
        namespace: TEMPORAL_NAMESPACE,
        taskQueue,
        workflowBundle,
        activities,
        maxConcurrentActivityTaskExecutions: Number(process.env.MAX_ACTIVITIES ?? 200),
        maxConcurrentWorkflowTaskExecutions: Number(process.env.MAX_WORKFLOW_TASKS ?? 100),
      }),
    ),
  );
  console.log(`Worker polling ${queues.join(', ')} on ${TEMPORAL_ADDRESS}`);
  const shutdown = () => workers.forEach((w) => w.shutdown());
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  await Promise.all(workers.map((w) => w.run()));
  await closePool();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
