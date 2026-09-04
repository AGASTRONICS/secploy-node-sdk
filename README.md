# Secploy Node.js SDK

Node.js SDK for the Secploy Security & Observability Platform. Track security events, monitor metrics, and maintain audit logs with ease.

## Installation

```bash
npm install secploy
```

## Quick Start

```typescript
import { Secploy } from "secploy";

// Initialize the SDK
const secploy = new Secploy({
  apiKey: "your-api-key",
  projectId: "your-project-id",
  environment: "development",
});

```

## Configuration

The SDK can be configured with the following options:

```typescript
interface SecployConfig {
  apiKey: string; // Your Secploy API key
  projectId: string; // Your project ID
  environment?: string; // Environment (development, staging, production)
  baseUrl?: string; // Custom API endpoint (optional)
}

interface SecployOptions {
  headers?: Record<string, string>; // Additional headers
  timeout?: number; // Request timeout in ms
}
```

## Features

### Security Events

Track security-related events such as:

- Authentication attempts
- Access control changes
- Security policy updates

### Metrics

Monitor performance and usage metrics:

- API response times
- Error rates
- Resource utilization

### Audit Logs

Maintain detailed audit trails for:

- User actions
- System changes
- Resource modifications

## Development

```bash
# Install dependencies
npm install

# Build the SDK
npm run build

# Run tests
npm test

# Lint code
npm run lint

# Format code
npm run format
```

## License

MIT License

## Security gate

The gate decides whether a request may proceed and enforces the decision. Point
it at your framework and blocked requests stop before they reach your routes.

```ts
import { Secploy } from "secploy";

const secploy = new Secploy({
  apiKey: process.env.SECPLOY_API_KEY!,
  environmentKey: process.env.SECPLOY_ENV_KEY!,
  organizationId: process.env.SECPLOY_ORG_ID!,
  ingestUrl: "https://ingest.secploy.com",
  gateMode: "cached",
});

app.use(secploy.gate.express());
```

Koa and Fastify are supported too (`secploy.gate.koa()`, `secploy.gate.fastify()`),
and `secploy.gate.check(req)` works anywhere for manual use.

### Gate modes

| Mode | Behaviour |
| --- | --- |
| `remote` (default) | Asks the API on every gated request. |
| `shadow` | Decides locally *and* remotely, reports disagreements, returns the remote answer. |
| `cached` | Decides from the local policy snapshot. No network call on the request path. |

`remote` is the default so upgrading the SDK never changes enforcement on its
own. Run `shadow` in production first: any disagreement is reported as a
`secploy.gate.shadow_mismatch` event. Once those are zero, switch to `cached`.

In `cached` mode the policy is held in process and refreshed over a WebSocket
when it changes. This means the gate keeps enforcing the last known policy even
while the Secploy API is unreachable, instead of failing open.

### Identity

The gate reads the caller's identity off the request (`req.user`, `req.session`,
`X-Forwarded-For`). Override it when your app stores identity somewhere else:

```ts
new SecployGate({ /* ... */, identityResolver: (req) => ({ identityKey: req.auth.sub }) });
```

Both `identityKey` and `identity_key` spellings are accepted everywhere.

### Real-time updates

Install `ws` to receive policy changes immediately:

```bash
npm install ws
```

Without it the SDK polls every 15 seconds instead.
