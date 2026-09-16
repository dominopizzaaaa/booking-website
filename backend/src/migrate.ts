import './config.js';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const result = spawnSync(process.execPath, [fileURLToPath(new URL('../node_modules/prisma/build/index.js', import.meta.url)), 'migrate', 'deploy', '--schema', fileURLToPath(new URL('../prisma/schema.prisma', import.meta.url))], { stdio: 'inherit', env: process.env });
process.exit(result.status ?? 1);
