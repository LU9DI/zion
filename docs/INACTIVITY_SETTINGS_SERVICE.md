# Authenticated inactivity settings service

`InactivitySettingsService` stores a validated preference record per authenticated Zion identity. The host supplies a `sessionAuthority` implementing `authenticateToken(token)` and a private `statePath`. No raw session tokens or private keys are persisted.

```js
import { InactivitySettingsService, inactivitySettingsToPolicyOptions } from './inactivity-settings-service.js';

const settingsService = new InactivitySettingsService({
  sessionAuthority,
  statePath: './state/inactivity-settings.json',
});
const result = await settingsService.getSettings(bearerToken);
const policyOptions = inactivitySettingsToPolicyOptions(result.settings);
```

Methods: `getSettings(token)`, `updateSettings(token, settings)`, and `resetSettings(token)`. They require a valid session token and scope all records to the identity established by that session. Settings are atomically written to a restrictive local file. Operations in one service instance are serialized to avoid lost updates from concurrent calls.

The service is transport-neutral; it is not itself an HTTP endpoint. A host API must enforce TLS, parse a `Authorization: Bearer ...` header, apply request-size/rate limits, and map `UNAUTHENTICATED` to HTTP 401 and invalid settings to HTTP 400/422. Never trust an identity ID sent in the request body. The token passed to the service is the extracted token value, not the full header string.

**Important:** `appliedToNode: false` is intentional. Persisting settings does not automatically reconfigure an already-running `InactivityResourcePolicy`; the node runtime must explicitly load the settings, apply `inactivitySettingsToPolicyOptions`, and coordinate live reconfiguration safely. The cloud preview still uses browser-local preferences until a real authenticated API is wired to it.
