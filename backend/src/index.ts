import { app } from './app.js';
import { prisma } from './db.js';
import { config } from './config.js';
import { startCalendarWorker } from './calendar-sync.js';
import { startChatReminderWorker } from './chat.js';
import { assertSchemaReady } from './schema-health.js';
import { createEmailProvider } from './email-provider.js';
import { startOutboundWorker } from './outbound-worker.js';
await prisma.$connect();
await assertSchemaReady(prisma);
const stopCalendarWorker = startCalendarWorker();
const stopChatReminderWorker = startChatReminderWorker();
const emailProvider = createEmailProvider({ mode: config.email.mode, apiKey: config.email.apiKey });
const stopOutboundWorker = startOutboundWorker({
  provider: emailProvider, from: { email: config.email.fromAddress || 'disabled@courtly.invalid', name: config.email.fromName },
  ...(config.email.replyTo ? { replyTo: config.email.replyTo } : {}),
});
const server = app.listen(config.port, () => console.log(`Courtly API listening on http://localhost:${config.port}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  stopCalendarWorker();
  stopChatReminderWorker();
  stopOutboundWorker();
  server.close(() => { void prisma.$disconnect().then(() => process.exit(0)); });
});
