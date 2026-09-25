import { app } from './app.js';
import { prisma } from './db.js';
import { config } from './config.js';
import { startCalendarWorker } from './calendar-sync.js';
await prisma.$connect();
const stopCalendarWorker = startCalendarWorker();
const server = app.listen(config.port, () => console.log(`Courtly API listening on http://localhost:${config.port}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  stopCalendarWorker();
  server.close(() => { void prisma.$disconnect().then(() => process.exit(0)); });
});
