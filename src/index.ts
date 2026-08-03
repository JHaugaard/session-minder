// src/index.ts
import { buildServer } from './server.js';

const app = buildServer();
const port = Number(process.env.PORT ?? 3000);
// Loopback by default; production sets HOST to the vps8 tailnet IP (Task 10).
// Never 0.0.0.0 — the service must not ride the public interface (spec:
// tailnet-only, Non-Goals).
const host = process.env.HOST ?? '127.0.0.1';

app.listen({ port, host }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
