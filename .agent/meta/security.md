# Security & Compliance Rationale
## Threat Model
**What we defend against:**
- Unconsented flow of personal data to third‑party analytics/marketing services.
- Accidental logging of PII by developers.
- Malicious or buggy scripts that bypass consent checks by calling endpoints directly.
- Unauthorised manipulation of consent state.
**What we do not defend against (out of scope):**
- A completely compromised browser (XSS can disable interceptor). But we mitigate by recommending Content Security Policy.
- Network‑level traffic interception (MitM) – use HTTPS.
## GDPR & ePrivacy Compliance
- **Article 7**: Consent must be freely given, specific, informed, and unambiguous. ConsentGuard enforces that data transfer only happens when the corresponding purpose consent is `true`.
- **Article 25 (Data Protection by Design)**: By embedding privacy directly into the data flow, the project implements “appropriate technical and organisational measures” at the infrastructure layer.
- **Article 30 (Records of Processing)**: Structured audit logs provide evidence of which events were blocked/stripped/forwarded, assisting in record‑keeping.
- **ePrivacy Directive**: The proxy acts as a technical gate, blocking tracking pixels and requests that would otherwise require prior consent.
## Data Handling & Retention
- **Consent Cache (Redis)**: Stores only `userId` ↔ `purposes` mapping. No IP address, no browser fingerprint. Configurable TTL (default 1 year). Can be integrated with external Consent Management Platforms.
- **Event Payloads**: Never stored or buffered. Proxy is stateless – data is passed through or discarded.
- **Logs**: As per error standards, PII‑free. Log retention policy outside this scope, but the format makes it trivial to redact.
## Secure Defaults
- `defaultConsent` defaults to `deny`, ensuring that unknown users are protected by default.
- Internal proxy secret (`AUTH_SECRET`) is mandatory; client must present it to use the ingest endpoint, preventing open proxy abuse.
- Admin endpoints use a separate secret to keep consent management distinct.
- Transformation rules have a “safe” default for unknown destinations: strip all fields that look like PII.
## Operational Security
- Redis should be firewalled; only the proxy needs access.
- All communication between client and proxy must be over HTTPS in production.
- The Docker image runs as a non‑root user.
- Environment variables are the recommended way to inject secrets; they are never logged.
## Audit & Compliance Reports
The Prometheus metrics and structured logs can be aggregated to demonstrate:
- Volume of blocked vs. allowed events per category.
- Destinations that most frequently attempt to send PII (helping compliance reviews).
- Consistently missing user IDs, which could indicate misconfiguration.