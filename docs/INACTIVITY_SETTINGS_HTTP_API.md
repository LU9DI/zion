# Inactivity settings HTTP API

`InactivitySettingsHttpApi` exposes `InactivitySettingsService` through a small authenticated HTTP adapter.

## Routes

- `GET /api/v1/settings/inactivity` — read the caller's settings.
- `PUT /api/v1/settings/inactivity` — replace settings with a JSON object containing exactly the five supported fields.
- `DELETE /api/v1/settings/inactivity` — restore defaults.

Every route requires `Authorization: Bearer <session-token>`. The session authority resolves the identity; clients cannot select an owner by supplying an identity ID. JSON writes require `Content-Type: application/json`. Request bodies are limited to 8 KiB. Responses use `Cache-Control: no-store` and security headers. Requests are rate-limited per remote address.

## Binding and transport security

The server binds to `127.0.0.1` by default. Remote binding is refused unless `allowRemoteBinding: true` is explicitly supplied. That option is only appropriate behind a trusted TLS-terminating ingress with access controls. This module does not itself provide TLS, production authentication/session issuance, CSRF protections for cookie auth (it uses bearer headers), durable distributed rate limiting, or a production deployment.

## Example

```js
import { InactivitySettingsService } from '../src/inactivity-settings-service.js';
import { InactivitySettingsHttpApi } from '../src/inactivity-settings-http-api.js';

const service = new InactivitySettingsService({ sessionAuthority, statePath: './state/inactivity-settings.json' });
const api = new InactivitySettingsHttpApi({ service, host: '127.0.0.1', port: 8787 });
await api.listen();
```

The service returns `appliedToNode: false`. Saving preferences is not evidence that the policy has been applied to a running node; a separate runtime adapter is still required.
