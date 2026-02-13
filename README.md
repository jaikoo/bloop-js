# @bloop/sdk

Lightweight error reporting SDK for [Bloop](https://github.com/jaikoo/eewwror) — self-hosted error tracking.

## Install

```bash
npm install @bloop/sdk
```

## Usage

```typescript
import { BloopClient } from "@bloop/sdk";

const bloop = new BloopClient({
  endpoint: "https://errors.myapp.com",
  projectKey: "bloop_abc123...",
  environment: "production",
  release: "1.2.0",
});

// Capture an Error object
try {
  riskyOperation();
} catch (err) {
  bloop.captureError(err, { route: "POST /api/users", httpStatus: 500 });
}

// Capture a structured event
bloop.capture({
  errorType: "ValidationError",
  message: "Invalid email format",
  route: "POST /api/users",
  httpStatus: 422,
});

// Flush on shutdown
await bloop.shutdown();
```

## Features

- **Zero dependencies** — Uses the Web Crypto API (works in Node.js and browsers)
- **Automatic batching** — Events are buffered and sent in configurable batches
- **HMAC-SHA256 signing** — All requests are cryptographically signed
- **Graceful shutdown** — `shutdown()` flushes pending events before exit

## License

MIT
