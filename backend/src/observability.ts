import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { Request, RequestHandler } from 'express';

type MetricKey = string;
type RequestMetric = { count: number; durationSeconds: number };
type LogWriter = (line: string) => void;

const requestIds = new WeakMap<Request, string>();
const requests = new Map<MetricKey, RequestMetric>();
const startedAt = Date.now();
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ROUTE_GROUPS = new Set([
  'account', 'admin', 'audit-events', 'auth', 'bookings', 'calendar', 'chats', 'classes',
  'commerce', 'family', 'health', 'integrity', 'live', 'locations', 'metrics', 'payments',
  'privacy', 'public', 'rentals', 'safeguarding', 'staff', 'students', 'workspace',
]);
const METHODS = new Set(['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT']);

function routeGroup(request: Request) {
  let pathname = '/';
  try { pathname = new URL(request.originalUrl, 'http://courtly.invalid').pathname; }
  catch { /* Express will reject a malformed target elsewhere. */ }
  const parts = pathname.split('/').filter(Boolean);
  if (parts[0] !== 'api') return parts[0] ? '/other' : '/';
  const candidate = parts[1]?.toLowerCase() || '';
  const group = ROUTE_GROUPS.has(candidate) ? candidate : 'other';
  return `/api/${group}`;
}

function statusClass(statusCode: number) {
  return `${Math.floor(statusCode / 100)}xx`;
}

function metricKey(method: string, group: string, status: string) {
  return JSON.stringify([method, group, status]);
}

export function requestIdFor(request: Request) {
  return requestIds.get(request);
}

export function requestObservability(options: { enabled: boolean; write?: LogWriter }): RequestHandler {
  const write = options.write || (line => console.log(line));
  return (request, response, next) => {
    const candidate = request.get('x-request-id')?.trim() || '';
    const requestId = REQUEST_ID.test(candidate) ? candidate : randomUUID();
    const candidateMethod = request.method.toUpperCase();
    const method = METHODS.has(candidateMethod) ? candidateMethod : 'OTHER';
    const group = routeGroup(request);
    const start = process.hrtime.bigint();
    requestIds.set(request, requestId);
    response.setHeader('X-Request-ID', requestId);

    response.once('finish', () => {
      const durationSeconds = Number(process.hrtime.bigint() - start) / 1e9;
      const status = statusClass(response.statusCode);
      const key = metricKey(method, group, status);
      const metric = requests.get(key) || { count: 0, durationSeconds: 0 };
      metric.count += 1;
      metric.durationSeconds += durationSeconds;
      requests.set(key, metric);
      if (options.enabled) write(JSON.stringify({
        timestamp: new Date().toISOString(), level: response.statusCode >= 500 ? 'error' : 'info',
        event: 'http_request', requestId, method, routeGroup: group, statusCode: response.statusCode,
        durationMs: Math.round(durationSeconds * 1000 * 100) / 100,
      }));
    });
    next();
  };
}

function bearerMatches(header: string | undefined, token: string) {
  if (!header?.startsWith('Bearer ') || !token) return false;
  const actual = Buffer.from(header.slice('Bearer '.length));
  const expected = Buffer.from(token);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function prometheusMetrics() {
  const lines = [
    '# HELP courtly_process_uptime_seconds Time since this API process started.',
    '# TYPE courtly_process_uptime_seconds gauge',
    `courtly_process_uptime_seconds ${Math.max(0, (Date.now() - startedAt) / 1000).toFixed(3)}`,
    '# HELP courtly_http_requests_total Completed HTTP requests.',
    '# TYPE courtly_http_requests_total counter',
    '# HELP courtly_http_request_duration_seconds_sum Total request duration in seconds.',
    '# TYPE courtly_http_request_duration_seconds_sum counter',
  ];
  for (const [key, metric] of [...requests].sort(([left], [right]) => left.localeCompare(right))) {
    const [method, group, status] = JSON.parse(key) as string[];
    const labels = `method=\"${method}\",route_group=\"${group}\",status_class=\"${status}\"`;
    lines.push(`courtly_http_requests_total{${labels}} ${metric.count}`);
    lines.push(`courtly_http_request_duration_seconds_sum{${labels}} ${metric.durationSeconds.toFixed(6)}`);
  }
  return `${lines.join('\n')}\n`;
}

export function metricsHandler(token: string): RequestHandler {
  return (request, response) => {
    if (!bearerMatches(request.get('authorization'), token)) {
      response.status(404).json({ error: 'Route not found' });
      return;
    }
    response.type('text/plain; version=0.0.4; charset=utf-8').send(prometheusMetrics());
  };
}

export function logUnexpectedRequestError(error: unknown, request: Request) {
  console.error(JSON.stringify({
    timestamp: new Date().toISOString(), level: 'error', event: 'unhandled_request_error',
    requestId: requestIdFor(request), errorType: error instanceof Error ? error.name : 'UnknownError',
  }));
}
