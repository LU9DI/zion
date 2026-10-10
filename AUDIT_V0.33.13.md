# Zion v0.33.13 — Real TLS handshake regression tests

## Scope

This release adds local HTTPS integration tests using a dedicated test-only CA and a localhost server certificate. No external network or production credential is used. The tests exercise Node.js's certificate chain and hostname validation with a real TLS handshake.

## Added cases

- Trusted test CA + matching `localhost` SAN: handshake succeeds and JSON response is received.
- Trusted chain + mismatched hostname: TLS rejects the connection.
- Certificate signed by an untrusted test CA: TLS rejects the connection.

The test CA private key is not included. The localhost private key is a test fixture only and must never be used outside automated tests.

## Reproduction

Requirements: Node.js 20 or later.

```sh
npm test
npm run check
npm run demo
unzip -t zion-v0.33.13-witness-tls-handshake.zip
sha256sum -c zion-v0.33.13-witness-tls-handshake.zip.sha256
```

## Limits

These tests exercise Node's TLS stack using a local HTTPS server; they do not prove a public certificate authority's production chain, revocation behavior, expired-certificate handling, DNS behavior, reverse-proxy configuration, or deployment correctness. Expired-certificate testing remains outstanding. No GitHub publication or production deployment is claimed.
