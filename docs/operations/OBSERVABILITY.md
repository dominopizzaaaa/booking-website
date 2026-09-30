# Production monitoring baseline

Status: OPEN until a named operations owner configures monitors, paging,
retention/redaction controls, and records an exercise. These endpoints and logs
are signals, not evidence that production is monitored.

## Signals

| Signal | Contract | Suggested use |
| --- | --- | --- |
| GET /api/live | Cheap process liveness; no database query | Restart/unresponsive-process detection |
| GET /api/health | PostgreSQL connection, runtime schema probe, configuration-derived capabilities; HTTP 503 on database/schema failure | Deployment readiness and external availability check |
| GET /api/metrics | Prometheus counters and duration sums grouped only by method, bounded route group, and status class | Authenticated scraping, error rate and latency-derived alerts |
| stdout JSON | Request ID, method, bounded route group, status, and duration | Search/correlation and redacted service dashboards |
| stderr JSON | Unexpected error class and request ID only | 5xx triage without leaking exception detail |

/api/metrics returns 404 unless OBSERVABILITY_TOKEN is a 32–256 character
printable-ASCII bearer token and the request sends it in Authorization. Keep
the token in the monitoring platform secret store. It is not a user API key,
must not be put in a URL, and should be rotated after exposure.

HTTP logging defaults on in production and off elsewhere; HTTP_LOGGING can
explicitly control it. Logs intentionally omit request/response bodies, query
strings, cookies, authorization, IP addresses, user-agent, user/account IDs,
raw paths, and error messages/stacks. Request IDs are generated UUIDs; only a
valid incoming UUID is propagated in X-Request-ID. The route label uses a fixed
allowlist to prevent attacker-chosen metric cardinality or log content.

## Pre-launch monitor checklist

- Record the canonical frontend and direct API origins and create an external
  readiness check for both /api/health paths. Validate expected capability
  values after every deployment; an HTTP 200 alone is insufficient.
- Configure a liveness signal only if the platform will not restart a process
  merely because PostgreSQL is briefly unavailable. Use readiness to remove
  traffic and liveness only for a wedged process.
- Scrape metrics over TLS from a restricted network path with the bearer token.
  Set traffic-specific baselines before choosing error-rate or latency paging
  thresholds. Do not invent thresholds without observed production traffic.
- Route logs to an approved restricted sink. Confirm field allowlisting,
  retention, deletion, access audit, and vendor/region review before launch.
- Monitor managed PostgreSQL storage, connections, CPU, memory, replication or
  PITR lag, backup failures/age, and certificate expiry in the provider console;
  application metrics cannot supply those facts.
- Add provider-side checks for stale outbound deliveries and failed Stripe
  webhook processing described in the main README. Do not expose database
  credentials to a third-party monitoring script merely to query these rows.
- Exercise one synthetic 5xx notification and one readiness failure, verify the
  named on-call receives them, attach evidence, and reset the test condition.
  Never generate a production incident by damaging the database or schema.

Alert ownership, escalation route, hours, acknowledgement objectives, severity
thresholds, and vendor contacts remain TBD; no reporting or response SLA is
asserted by this document.
