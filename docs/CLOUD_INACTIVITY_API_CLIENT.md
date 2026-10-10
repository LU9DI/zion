# Cloud inactivity settings API client

The Cloud settings page supports an optional authenticated backend. The host app may expose:

```js
window.ZionAuth = {
  async getAccessToken() {
    // Return a current short-lived session token from the actual auth system.
    // Never hardcode a token in the frontend or store it in this module.
  }
};
```

When this provider is present, the UI reads and writes `/api/v1/settings/inactivity` through `ZionInactivitySettingsApiClient`. An optional `<meta name="zion-api-base" content="https://api.example.invalid">` can define the API base URL. Use only a trusted HTTPS origin in production. The client does not persist tokens, does not attach ambient cookies, disables caching, rejects redirects, and limits request time. Authentication/API failures are visible and never silently fall back to local writes.

When no provider is present, the interface remains in local preview mode and says so. This is intentional: this client is not an authentication system. A host integration must supply token acquisition, secure origin configuration, and the deployed API. API responses currently report `appliedToNode: false`; saving a preference is not proof of a live policy transition.
