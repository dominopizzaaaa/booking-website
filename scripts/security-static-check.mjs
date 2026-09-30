#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { extname, relative, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = resolve(new URL('..', import.meta.url).pathname);
const tracked = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
const textExtensions = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.md', '.yml', '.yaml', '.prisma', '.sql', '.txt']);
const findings = [];
const secretPatterns = [
  ['private key material', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['Stripe live secret', /\bsk_live_[A-Za-z0-9]{16,}\b/],
  ['Stripe webhook secret', /\bwhsec_[A-Za-z0-9]{16,}\b/],
  ['GitHub token', /\b(?:ghp|github_pat)_[A-Za-z0-9_]{20,}\b/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{30,}\b/],
];

for (const file of tracked) {
  if (file === 'scripts/security-static-check.mjs') continue;
  if (!textExtensions.has(extname(file)) && !file.endsWith('.env.example')) continue;
  const contents = readFileSync(resolve(root, file), 'utf8');
  for (const [description, pattern] of secretPatterns) {
    if (pattern.test(contents)) findings.push(`${relative(root, file)}: possible ${description}`);
  }
  if (/src\/.+\.(?:ts|tsx|js|mjs|cjs)$/.test(file)) {
    if (/\beval\s*\(/.test(contents)) findings.push(`${relative(root, file)}: dynamic eval in runtime source`);
    if (/new\s+Function\s*\(/.test(contents)) findings.push(`${relative(root, file)}: dynamic Function in runtime source`);
  }
}

if (findings.length) {
  console.error('Conservative static security check failed:\n' + findings.map(finding => `- ${finding}`).join('\n'));
  process.exit(1);
}
console.log(`Static security check passed (${tracked.length} tracked files examined).`);
