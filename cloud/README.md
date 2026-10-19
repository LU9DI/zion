# Zion Cloud UI preview

A responsive, dependency-free Portuguese (Brazil) interface for Zion Cloud.

## Run locally

Requires Node.js 20 or newer:

```sh
npm run cloud:preview
```

Open `http://127.0.0.1:4173` in the same computer. Set `PORT` to change the port.

## Scope and safety

This is an interactive frontend preview, not a connected cloud service. The file picker only adds selected file metadata to the current page session; file bytes are not uploaded, persisted, or shared. The social area supports local interaction with fictional profiles: follows and messages exist only in memory for that browser session and are not delivered to other people. There are no real user accounts, remote messaging, or synced follow graphs yet. The repository contains an experimental end-to-end encrypted message-envelope module, but the UI is not connected to it and no network delivery is implemented. See [`../docs/SOCIAL_MESSAGING_PROTOCOL.md`](../docs/SOCIAL_MESSAGING_PROTOCOL.md). Node health, storage usage, activity, and contribution toggles are illustrative. The preview server binds to loopback (`127.0.0.1`) and serves only static files. A real deployment requires an authenticated API, authorization checks, durable metadata, upload/download endpoints, CSRF/origin policy where applicable, quota enforcement, and trustworthy node health sources.
