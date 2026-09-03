import { config } from './config/env.js';
import { prisma } from './config/prisma.js';
import { createApp } from './app.js';

const app = createApp();
const server = app.listen(config.port, () => console.log(`Server listening on port ${config.port}`));
app.locals.recoveryWorker.start();

async function shutdown() {
  app.locals.recoveryWorker.stop();
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
