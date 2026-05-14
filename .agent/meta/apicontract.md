# API Contract & Route Schema
All routes are served by the ConsentGuard proxy (standalone or mounted under a prefix like `/analytics`).
## Authentication
Requests to the proxy from the client interceptor require a **pre‑shared secret** sent as `Authorization: Bearer <PROXY_SECRET>` (env var). This prevents open relay abuse. The admin endpoints (`PUT /consent/:userId`) may use a different secret (`ADMIN_SECRET`).
### `POST /ingest/:destination`
**Purpose**: Ingest an analytics event from the browser, scrubbed and forwarded based on consent.
- **Headers**:
    - `Authorization: Bearer <PROXY_SECRET>`
    - `X-Consent-UserId: <userId>` (required if no cookie)
    - `Content-Type: application/json`
- **URL Params**: `destination` – e.g., `ga4`, `mixpanel`, `facebook_pixel`.
- **Body**: Original analytics payload (JSON), exactly as the analytics SDK would send to its endpoint.
- **Responses**:
    - `204 No Content` – Event blocked (no consent) or successfully forwarded.
    - `400 Bad Request` – Invalid JSON or missing `destination`.
    - `502 Bad Gateway` – Destination upstream unreachable.
    - `403 Forbidden` – Invalid/missing auth token.
**Example (GA4)**:
```text
POST /ingest/ga4
Authorization: Bearer s3cret
X-Consent-UserId: user_abc123
Content-Type: application/json
{
  "client_id": "123.456",
  "events": [{
    "name": "purchase",
    "params": {
      "currency": "EUR",
      "value": 42.0,
      "email": "user@example.com"
    }
  }]
}
```
If `analytics` consent is `true`, `email` is stripped and the rest forwarded. If `false`, returns `204`.
### `GET /health`
**Purpose**: Readiness probe.
- **Response**: `200 OK` with `{ "status": "ok", "redis": "connected" }`
- No auth required.
### `PUT /consent/:userId`
**Purpose**: Update consent state for a user (called by consent banner backend or SPA).
- **Headers**: `Authorization: Bearer <ADMIN_SECRET>`
- **Body**:
```json
{
  "purposes": {
    "necessary": true,
    "analytics": true,
    "marketing": false
  },
  "metadata": {
    "source": "one-trust",
    "timestamp": 1715692800
  }
}
```
- **Response**: `200 OK` if stored, `400` if invalid purposes.
### `GET /consent/:userId`
**Purpose**: Retrieve current consent snapshot (for debugging/auditing).
- **Headers**: `Authorization: Bearer <ADMIN_SECRET>`
- **Response**: `200` with the consent object as stored in Redis, or `404` if not found.
### `GET /metrics`
**Purpose**: Prometheus metrics endpoint (internal port `9090`). Returns metrics like:
- `consentguard_requests_total{decision, destination}`
- `consentguard_forward_duration_seconds`
- `consentguard_cache_hits_total`