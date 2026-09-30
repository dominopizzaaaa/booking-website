#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const severityRank = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };
let failed = false;

for (const requested of process.argv.slice(2)) {
  const directory = resolve(requested);
  const lock = JSON.parse(readFileSync(resolve(directory, 'package-lock.json'), 'utf8'));
  const result = spawnSync('npm', ['audit', '--omit=dev', '--json'], {
    cwd: directory, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  });
  let audit;
  try { audit = JSON.parse(result.stdout); }
  catch {
    console.error(`Dependency audit failed for ${requested}: npm did not return JSON.\n${result.stderr.trim()}`);
    failed = true;
    continue;
  }
  if (audit.error) {
    console.error(`Dependency audit failed for ${requested}: ${audit.error.summary || audit.error.message || 'registry error'}`);
    failed = true;
    continue;
  }

  const blocking = [];
  const developmentOnly = [];
  for (const vulnerability of Object.values(audit.vulnerabilities || {})) {
    if (severityRank[vulnerability.severity] < severityRank.high) continue;
    const vulnerableProductionNodes = (vulnerability.nodes || []).filter(node => {
      const entry = lock.packages?.[node];
      // npm marks packages reachable only through development or optional
      // development tools as dev or devOptional in lockfile v3.
      return !entry || (entry.dev !== true && entry.devOptional !== true);
    });
    const record = `${vulnerability.name} (${vulnerability.severity})`;
    if (vulnerableProductionNodes.length) blocking.push(`${record}: ${vulnerableProductionNodes.join(', ')}`);
    else developmentOnly.push(record);
  }
  if (developmentOnly.length) {
    console.warn(`${requested}: non-blocking development/build advisories: ${developmentOnly.join(', ')}`);
  }
  if (blocking.length) {
    console.error(`${requested}: high/critical production dependency advisories:\n${blocking.map(item => `- ${item}`).join('\n')}`);
    failed = true;
  } else {
    console.log(`${requested}: no high/critical advisories in the installed production dependency graph.`);
  }
}

if (process.argv.length < 3) {
  console.error('Usage: node scripts/dependency-audit.mjs <package-directory> [...]');
  process.exit(2);
}
if (failed) process.exit(1);
