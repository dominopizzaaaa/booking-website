import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { metricsHandler, requestObservability } from '../src/observability.js';

describe('HTTP observability', () => {
  it('keeps a safe caller request ID and emits a bounded, redacted log', async () => {
    const lines: string[] = [];
    const app = express();
    app.use(requestObservability({ enabled: true, write: line => lines.push(line) }));
    app.get('/api/public/:secret', (_req, response) => response.json({ ok: true }));

    const response = await request(app)
      .get('/api/public/private-club-token?email=person@example.test')
      .set('X-Request-ID', '123e4567-e89b-42d3-a456-426614174000');

    expect(response.headers['x-request-id']).toBe('123e4567-e89b-42d3-a456-426614174000');
    expect(lines).toHaveLength(1);
    const log = JSON.parse(lines[0]);
    expect(log).toMatchObject({ event: 'http_request', requestId: '123e4567-e89b-42d3-a456-426614174000', method: 'GET', routeGroup: '/api/public', statusCode: 200 });
    expect(lines[0]).not.toContain('private-club-token');
    expect(lines[0]).not.toContain('person@example.test');
  });

  it('replaces malformed IDs and protects the metrics endpoint with a bearer', async () => {
    const app = express();
    app.use(requestObservability({ enabled: false }));
    app.get('/api/live', (_req, response) => response.json({ ok: true }));
    app.get('/api/metrics', metricsHandler('a-long-monitoring-token'));

    const live = await request(app).get('/api/live').set('X-Request-ID', 'attacker-chosen-value');
    expect(live.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect((await request(app).get('/api/metrics')).status).toBe(404);
    const metrics = await request(app).get('/api/metrics').set('Authorization', 'Bearer a-long-monitoring-token');
    expect(metrics.status).toBe(200);
    expect(metrics.text).toContain('courtly_http_requests_total');
    expect(metrics.text).not.toContain('a-long-monitoring-token');
  });
});
