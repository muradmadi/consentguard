# Error Handling & Logging Standards
## Principle: No PII in Logs
ConsentGuard logs **must never** contain raw payloads, email addresses, IP addresses, or any user identifiers beyond the pseudonymous `userId`. All log entries must be safe for audit.
## Log Format
Structured JSON, printed to stdout. Every log line includes:
```json
{
  "level": "info" | "warn" | "error",
  "timestamp": "ISO8601",
  "msg": "human readable",
  "event": "consent_decision",
  "destination": "ga4",
  "decision": "block" | "strip" | "pass",
  "userId": "a1b2c3",
  "error": "..." // only for error level, never includes payload
}
```
## Error Codes & Behaviour

| Scenario                         | Action                                                                  | Log Level | Response                                      |
| -------------------------------- | ----------------------------------------------------------------------- | --------- | --------------------------------------------- |
| **Redis timeout/unreachable**    | Deny (default) or Allow (if `defaultConsent: 'allow'`)                  | `error`   | `204` (block silently)                        |
| **Destination config missing**   | Log warning, forward raw payload? No. Block with `400` (missing rules). | `warn`    | `400` + `{"error":"unsupported_destination"}` |
| **Invalid JSON payload**         | Reject                                                                  | `info`    | `400`                                         |
| **Missing `userId`**             | Deny                                                                    | `warn`    | `204`                                         |
| **Upstream destination 4xx/5xx** | Log error, no retry (idempotent)                                        | `error`   | `502`                                         |
| **Auth failure**                 | Reject                                                                  | `info`    | `403`                                         |

## What Must Not Be Logged
- Any part of the incoming analytics payload.
- HTTP headers except `X-Consent-UserId`.
- Destination API keys.
- Real user IPs (if proxy receives them, strip before logging).
## Retry Strategy
The proxy does **not** retry failed upstream requests. Analytics events are fire‑and‑forget; the client side handles its own retries if needed. This keeps the proxy fast and simple.