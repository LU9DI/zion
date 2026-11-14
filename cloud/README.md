# Zion Cloud web interface preview

A responsive, dependency-free web interface prototype for Zion. All user-facing text in the invitation entry page is in English.

## Run locally

Requires Node.js 20 or newer:

```sh
npm run cloud:preview
```

Open `http://127.0.0.1:4173` in the same computer. Set `PORT` to change the port. The invitation onboarding preview is available at `/invite.html`.

## Invitation policy

Zion is invitation-only. The first 1,000 admitted users form the founding cohort. Every admitted user, including users who joined through an invitation after the founding cohort, may issue an unlimited number of invitations. Each invitation is intended for one successful redemption.

The invitation page is currently a visual/interaction preview only. It does not validate, transmit, redeem, or consume invitation codes and does not create accounts. Do not enter a real invitation secret into this preview.

## Scope and safety

This is an interactive frontend preview, not a connected cloud service. The file picker on the main preview only adds selected file metadata to the current page session; file bytes are not uploaded, persisted, or shared. The social area supports local interaction with fictional profiles: follows and messages exist only in memory for that browser session and are not delivered to other people. There are no real user accounts, remote messaging, or synced follow graphs yet. The repository contains an experimental end-to-end encrypted message-envelope module, but the UI is not connected to it and no network delivery is implemented. Node health, storage usage, activity, and contribution toggles are illustrative.

The preview server binds to loopback (`127.0.0.1`) and serves only static files. A real deployment requires an authenticated API, authorization checks, durable metadata, upload/download endpoints, CSRF/origin policy where applicable, quota enforcement, and trustworthy node health sources. Global invitation redemption and founding-member assignment additionally require a canonical, quorum-committed distributed state transition; a local counter or single database is not sufficient.
