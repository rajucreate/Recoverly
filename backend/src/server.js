import { config } from './config/env.js';
import { prisma } from './config/prisma.js';
import { createApp } from './app.js';

const server = createApp().listen(config.port, () => console.log(`Server listening on port ${config.port}`));

async function shutdown() {
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
