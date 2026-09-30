import bcrypt from 'bcryptjs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from '../src/app.js';
import { config, type AdminOperatorCredential } from '../src/config.js';
import { generateTotpCode } from '../src/account-security-crypto.js';
import { prisma } from '../src/db.js';

const password = 'Courtly-named-admin-test-123';
const totpSecret = 'JBSWY3DPEHPK3PXP';
const original = {
  adminOperators: config.adminOperators, adminPassword: config.adminPassword,
  adminSessionSecret: config.adminSessionSecret, adminSessionSecretConfigured: config.adminSessionSecretConfigured,
};

async function namedOperator(): Promise<AdminOperatorCredential> {
  return {
    id: 'ops_named_test', name: 'Named Test Operator', email: 'named.operator@example.test',
    passwordHash: await bcrypt.hash(password, 12), totpSecret,
  };
}

afterEach(async () => {
  config.adminOperators = original.adminOperators;
  config.adminPassword = original.adminPassword;
  config.adminSessionSecret = original.adminSessionSecret;
  config.adminSessionSecretConfigured = original.adminSessionSecretConfigured;
  await prisma.rateLimitCounter.deleteMany({ where: { namespace: 'admin-login' } });
});
beforeEach(async () => {
  await prisma.rateLimitCounter.deleteMany({ where: { namespace: 'admin-login' } });
});

describe.sequential('named admin operator authentication', () => {
  it('binds the named operator and expiry to a signed, credential-versioned cookie', async () => {
    const operator = await namedOperator();
    config.adminOperators = [operator];
    config.adminPassword = 'legacy-must-not-win';
    config.adminSessionSecret = Buffer.alloc(32, 21);
    config.adminSessionSecretConfigured = true;
    const agent = request.agent(app);

    await agent.post('/api/admin/login').send({ password: 'legacy-must-not-win' }).expect(400);
    await agent.post('/api/admin/login').send({ email: operator.email, password: 'wrong-password' }).expect(401);
    await agent.post('/api/admin/login').send({ email: operator.email, password }).expect(401);
    const login = await agent.post('/api/admin/login').send({
      email: operator.email.toUpperCase(), password, totpCode: generateTotpCode(totpSecret),
    }).expect(200);
    expect(login.body).toEqual({
      ok: true, authMode: 'named', operator: { id: operator.id, name: operator.name, email: operator.email },
    });
    expect((await agent.get('/api/admin/session').expect(200)).body).toMatchObject({
      configured: true, authenticated: true, authMode: 'named', sensitiveAccess: true,
      operator: { id: operator.id, name: operator.name, email: operator.email },
    });

    config.adminOperators = [{ ...operator, name: 'Renamed Operator' }];
    expect((await agent.get('/api/admin/session').expect(200)).body.authenticated).toBe(false);

    config.adminOperators = [operator];
    await agent.post('/api/admin/login').send({
      email: operator.email, password, totpCode: generateTotpCode(totpSecret),
    }).expect(200);
    config.adminOperators = [{ ...operator, passwordHash: await bcrypt.hash('rotated-password', 12) }];
    expect((await agent.get('/api/admin/session').expect(200)).body).toMatchObject({
      authenticated: false, operator: null, sensitiveAccess: false,
    });
  });

  it('keeps legacy local sessions away from sensitive reads and mutations', async () => {
    config.adminOperators = [];
    config.adminPassword = 'legacy-local-admin-test';
    const agent = request.agent(app);
    const login = await agent.post('/api/admin/login').send({ password: config.adminPassword }).expect(200);
    expect(login.body).toEqual({ ok: true, authMode: 'legacy', operator: null });
    await agent.get('/api/admin/overview').expect(200);
    for (const path of ['/api/admin/chats', '/api/admin/privacy-requests', '/api/admin/safeguarding/reports']) {
      const response = await agent.get(path).set('X-Courtly-Privacy-Operator', '1').expect(403);
      expect(response.body).toMatchObject({ code: 'NAMED_ADMIN_REQUIRED' });
    }
    const purge = await agent.post('/api/admin/purge-demos').send({}).expect(403);
    expect(purge.body).toMatchObject({ code: 'NAMED_ADMIN_REQUIRED' });
  });
});
