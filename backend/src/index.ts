import { app } from './app.js';
import { prisma } from './db.js';
import { config } from './config.js';
await prisma.$connect();
const server = app.listen(config.port, () => console.log(`Courtly API listening on http://localhost:${config.port}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { server.close(() => { void prisma.$disconnect().then(() => process.exit(0)); }); });
