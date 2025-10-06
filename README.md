# Secploy Node.js SDK

Node.js SDK for the Secploy Security & Observability Platform. Track security events, monitor metrics, and maintain audit logs with ease.

## Installation

```bash
npm install secploy-sdk
```

## Quick Start

```typescript
import { Secploy } from "secploy-sdk";

// Initialize the SDK
const secploy = new Secploy({
  apiKey: "your-api-key",
  projectId: "your-project-id",
  environment: "development",
});

// Initialize with server configuration
await secploy.initialize();

// Track a security event
await secploy.recordSecurityEvent("auth.login.attempt", {
  userId: "123",
  success: true,
  ip: "192.168.1.1",
});

// Record a metric
await secploy.recordMetric("api.response.time", 150, {
  endpoint: "/users",
  method: "GET",
});

// Record an audit log
await secploy.recordAuditLog("update", "user", "user-123", {
  changes: {
    email: "new@email.com",
  },
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
