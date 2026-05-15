# 🛡️ ConsentGuard

**Universal, Privacy-First Consent Enforcement Proxy for the Modern Web**

ConsentGuard is an infrastructure-level privacy middleware that brings **every** third-party analytics and marketing tool into GDPR/CCPA compliance—without changing a line of existing instrumentation code.

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.1.0--beta-orange.svg)](package.json)
[![Status](https://img.shields.io/badge/milestone-95%25-green.svg)](ARCHITECTURE.md)

---

## ✨ Why ConsentGuard?

*   **Zero-SDK Modification**: Works with GA4, Mixpanel, TikTok, Facebook, and 50+ others out-of-the-box.
*   **Dual-Mode Enforcement**: Client-side interception + Server-side transformation.
*   **Privacy by Default**: Data is scrubbed or blocked at the network layer *before* it leaves your infrastructure.
*   **Audit-Ready**: Detailed audit logs for every single data point sent to third parties.
*   **Ultra-Low Latency**: Hybrid LRU caching ensures <10ms overhead p99.

## 🚀 Quick Start

### 1. Install the CLI
```bash
npm install -g @consentguard/cli
```

### 2. Initialize your project
```bash
consentguard init
```
This will guide you through setting up your proxy, Redis connection, and generating production-ready Docker assets.

### 3. Start the Proxy
```bash
consentguard start
```

### 4. Enable Client-Side Interception
Add this to the very top of your application entry point:
```javascript
import '@consentguard/client';
```

## 🛠️ Components

| Package | Description |
| :--- | :--- |
| [`@consentguard/client`](./packages/client) | 5KB zero-dependency network interceptor. |
| [`@consentguard/server`](./packages/server) | Hono-based proxy with hybrid storage resilience. |
| [`@consentguard/cli`](./packages/cli) | Developer tool for management and diagnostics. |
| [`@consentguard/admin`](./packages/admin) | Premium dark-themed dashboard for governance. |

## 📖 Documentation

- [**Technical Architecture**](./ARCHITECTURE.md) — How it works under the hood.
- [**Destination Registry**](./.agent/meta/addeddestinations.md) — List of supported tools and their scrubbing rules.
- [**Kitchen Sink Demo**](./examples/kitchen-sink) — Interactive playground.

## 🤝 Contributing

We are building the definitive registry for web privacy. Want to add a new destination? Check out our [Contributing Guide](./CONTRIBUTING.md).

---

Built with ❤️ by the ConsentGuard Team. Focused on making the web safer, one request at a time.
