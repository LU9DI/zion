# Local content screening and malware scanner integration

## Current built-in screening

Zion currently performs a local SHA-256 exact-match check against an explicitly supplied blacklist before encryption. This is useful for rejecting known byte-identical content when the blacklist is current, but it is **not antivirus** and does not detect unknown malware, polymorphic files, packed executables, malicious scripts, ransomware, or harmful behavior. A changed file produces a different digest.

The built-in check does not upload the plaintext or digest to a remote moderation service. The optional CLI helper `npm run content:screen-local` uses a local JSON list of SHA-256 digests.

## Scanner adapter contract

`ZionClient` accepts an injected `malwareScanner` with this contract:

```js
const malwareScanner = {
  async scan({ content, sha256, bytes }) {
    // Run a locally installed and maintained scanning engine here.
    // Return { verdict: 'clean' } only after a positive clean result.
    // Return malicious, suspicious, or unknown for every non-clean result.
  },
};

const client = new ZionClient({
  storageAdapter,
  malwareScanner,
  requireMalwareScan: true,
});
```

The scanner runs on the client before any chunk is encrypted or passed to the storage adapter. It receives a copy of the plaintext buffer; mutating that copy cannot change the bytes Zion encrypts. Only the exact verdict `{ verdict: 'clean' }` allows upload. Malicious, suspicious, missing, unknown, and scanner-error outcomes fail closed and make no storage-adapter calls.

Set `requireMalwareScan: true` in any application policy that must not upload without a scanner. Construction fails if no scanner is configured. Without that option and without an adapter, upload retains the legacy exact-hash-only behavior and reports `screening.malwareScan: 'not-configured'`; this is not a malware-safe mode.

## ClamAV adapter

Zion now provides `createClamAVScanner()` in `src/clamav-scanner.js`. It invokes the locally installed ClamAV `clamscan` executable without a shell, writes the input to a uniquely named file in a private temporary directory, and removes that directory after the scan. The temporary file is plaintext while scanning; cleanup is best-effort and is not a secure-erasure guarantee.

```js
import { ZionClient } from './src/zion-client.js';
import { createClamAVScanner } from './src/clamav-scanner.js';

const client = new ZionClient({
  storageAdapter,
  malwareScanner: createClamAVScanner({
    commandPath: 'clamscan', // or an absolute path managed by the host
    timeoutMs: 30_000,
    maxFileBytes: 256 * 1024 * 1024,
  }),
  requireMalwareScan: true,
});
```

The adapter accepts only ClamAV's explicit `<temporary-file>: OK` result as clean. A signature match is malicious; engine errors, timeouts, output-limit violations, malformed results, and size-limit outcomes never become clean. Zion's existing fail-closed upload gate rejects all non-clean verdicts before encryption and storage.

Install and maintain ClamAV and its signature database on the user's device or host before enabling this adapter. For example, on Debian/Ubuntu install the distribution's `clamav` package and keep its signature database updated using the platform's supported update service. The Zion repository does not install, update, or manage the antivirus engine. A scanner that is missing or cannot access a current database causes upload to fail closed.

## Deployment requirements and limits

- Zion does not bundle or claim to provide an antivirus engine. The host application must integrate, update, and operate a reputable local scanner and its signature database.
- The adapter should scan archives safely with decompression limits, nested archive limits, timeouts, and protections against parser exploits. Do not execute uploaded files to inspect them.
- Scanner engine errors, timeouts, unsupported formats, encrypted archives, and indeterminate verdicts should be treated as non-clean.
- Keep scanning before client-side encryption so storage peers never need plaintext or file keys. Do not send private keys to scanners or storage nodes.
- The adapter is an integration boundary, not proof of scanner correctness, malware detection coverage, or production readiness. Independently test the selected engine and the complete client upload path.
- Hash blacklists are supplemental indicators only. They are not a substitute for signature-based or behavior-based malware scanning.
