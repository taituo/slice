import { buildApp } from './app';

const port = Number(process.env.PORT ?? 4000);
const app = buildApp({ logger: true });

app.listen({ port, host: '0.0.0.0' }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => app.close().then(() => process.exit(0)));
