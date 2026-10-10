# Applying saved inactivity settings to a running node

`InactivitySettingsService` stores validated preferences for an authenticated identity. Saving preferences does not, by itself, change a running node. `InactivityPolicySettingsBridge` is the explicit boundary that fetches the authenticated owner's settings, verifies that the session belongs to the configured node owner, converts the validated settings, and atomically replaces the live policy's options.

```js
import { InactivityPolicySettingsBridge } from '../src/inactivity-policy-settings-bridge.js';

const bridge = new InactivityPolicySettingsBridge({
  settingsService,
  policy: inactivityPolicy,
  ownerIdentityId: configuredOwnerIdentityId,
  getAccessToken: () => sessionAuthority.issueOrGetOwnerSession(),
});

const result = await bridge.applySavedSettings();
if (!result.ok) {
  // Keep the existing live policy. Surface a safe error to the owner/operator.
} else {
  // `appliedToNode: true` means the in-memory policy accepted the options.
}
```

The host must provide a real session/token provider; do not hard-code tokens. Call `applySavedSettings()` after authentication and whenever the owner explicitly saves settings. If settings are applied on startup, do so before starting the inactivity scheduler. The bridge fails closed on missing authentication, identity mismatch, malformed settings, or service errors and preserves the currently active policy options.

Each policy evaluation snapshots its immutable options at the beginning, so a refresh during an asynchronous callback cannot mix thresholds within a single evaluation.

This bridge does not provide cross-process configuration propagation, remote notification delivery, or a production deployment. Those remain host responsibilities.
