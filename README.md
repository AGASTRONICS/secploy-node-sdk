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

## Browser and React Native

The same package ships two front-end clients as separate entry points. Neither
imports anything from Node (`crypto`, `path`, `axios`, `ws`), so bundlers need no
polyfills and the server client's code never reaches a page or an app.

| Import | For |
| --- | --- |
| `secploy` | Node servers: the gate, identity reporting, error capture |
| `secploy/browser` | Web apps: error capture and session replay |
| `secploy/react-native` | React Native apps: error capture and session replay |

Both clients capture uncaught errors and unhandled rejections, scrub every event
with the same rules as the Node client, and report errors in the shape every
Secploy SDK uses, so a browser error groups and renders like a server one.

### Session replay

Replay records what the user saw in the seconds **before an error**. It is
off by default, because it records somebody else's user.

It runs in error-buffer mode, like the Flutter SDK. The recent past is held in
memory and discarded as it ages, and it is only uploaded when an error is
reported. An app that does not crash sends nothing. The recording is attached to
the error it explains, and appears on that issue in the dashboard.

#### Web

```bash
npm install secploy rrweb
```

```ts
import { record } from "rrweb";
import { SecployBrowser } from "secploy/browser";

SecployBrowser.init({
  apiKey: "...",
  environmentKey: "...",
  organizationId: "...",
  ingestUrl: "https://ingest.secploy.com/ingest",
  release: "2.4.1",
  replay: { enabled: true, record },
});
```

The web recording is DOM-based (rrweb), not screenshots. It records the page
once, then only what changes, so it costs the page almost nothing while nothing
is going wrong. A fresh snapshot is taken every `bufferSeconds` (default 30).
The window uploaded for an error covers the last 30 to 60 seconds.

Masking happens before anything is recorded. Real characters never enter an
event, so they cannot leave the page.

- All text is masked by default. Add `data-secploy-unmask` to an element to
  record its text as-is. Add `data-secploy-mask` inside it to mask again.
- Every input value is masked. Values inside `data-secploy-unmask` are recorded,
  except password fields, which are never recorded.
- Images, video, canvas and iframes are replaced by placeholders unless they sit
  inside `data-secploy-unmask`. Add `data-secploy-block` to anything you want
  left out entirely.

`maskAllText: false` and `blockMedia: false` relax those defaults if you want to.

#### React Native

```bash
npm install secploy react-native-view-shot
```

```tsx
import { captureRef } from "react-native-view-shot";
import { SecployReactNative, SecployReplayRoot, SecployUnmask } from "secploy/react-native";

SecployReactNative.init({
  apiKey: "...",
  environmentKey: "...",
  organizationId: "...",
  ingestUrl: "https://ingest.secploy.com/ingest",
  replay: { enabled: true, captureRef },
});

export default function Root() {
  return (
    <SecployReplayRoot>
      <App />
    </SecployReplayRoot>
  );
}
```

React Native records one small JPEG per second, about a third of the screen's
size, by default. Each frame is masked on the device before it is kept.

- Every `Text`, `TextInput`, `Image`, web view, video, map and camera is painted
  over by default. Wrap a subtree in `<SecployUnmask>` to record it as-is.
- Wrap anything else sensitive, such as a custom-drawn chart, in
  `<SecployMask>`.
- If the SDK cannot work out where every masked element is, it drops the frame.
  An unmasked frame is never kept.

A fatal JS error holds the app open for up to `fatalFlushTimeoutMs` (default
3000). That gives the report and its recording a chance to upload before React
Native's own handler ends the app.

#### What the deployment needs

Recordings are uploaded straight from the browser or device to object storage,
using a URL signed by the Secploy API. For web replay, both of the following
must accept requests from your site's origin:

- The API's `/projects/replay/upload-url/` endpoint.
- The replay bucket, which must accept PUT requests.

Secploy's hosted service is configured for this. React Native needs neither,
because native apps are not subject to CORS.
