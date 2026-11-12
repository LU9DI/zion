# Local content screening and malware scanner integration

## Current built-in screening

Zion currently performs a local SHA-256 exact-match check against an explicitly supplied blacklist before encryption. This is useful for rejecting known byte-identical content when the blacklist is current, but it is **not antivirus** and does not detect unknown malware, polymorphic files, packed executables, malicious scripts, ransomware, or harmful behavior. A changed file produces a different digest.

The built-in check does not upload the plaintext or digest to a remote moderation service. The optional CLI helper `npm run content:screen-local` uses a local JSON list of SHA-256 digests.

## Scanner adapter contract

`ZionClient` accepts an injected `malwareScanner` with this contract. The scanner receives an `AbortSignal` and is bounded by `malwareScanTimeoutMs` (default 30 seconds; allowed range 1 ms to 5 minutes):

```js
const malwareScanner = {
  async scan({ content, sha256, bytes, signal }) {
    // Pass signal to the scanner process and terminate it when aborted.
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


## ClamAV CLI adapter

Zion includes an adapter for a locally installed ClamAV CLI. It starts the executable without a shell, streams file bytes through standard input (no temporary plaintext file), maps ClamAV's clean/infected exit results to explicit verdicts, and treats missing executables or indeterminate results as scanner errors. The adapter sets bounded scan defaults: 25 seconds of engine scan time, 100 MiB per extracted file, 200 MiB total scan size, 10,000 extracted files, and archive recursion depth 10. Encrypted content and exceeded scan limits are configured to raise ClamAV alerts, which Zion rejects.

```js
import { ZionClient } from './zion-client.js';
import { createClamAVScanner } from './clamav-scanner.js';

const client = new ZionClient({
  storageAdapter,
  malwareScanner: createClamAVScanner({ executable: 'clamscan' }),
  requireMalwareScan: true,
  malwareScanTimeoutMs: 30_000,
});
```

The host must install ClamAV and keep its signature database updated (for example, using the platform's approved ClamAV package and `freshclam` update process). Zion does not install the engine, update signatures, or guarantee detection quality. The adapter applies ClamAV archive and scan limits, but it is not a sandbox: OS-level process isolation, CPU/memory quotas, filesystem restrictions, and operational signature-update monitoring must be enforced by the host deployment. Test the exact ClamAV version and command behavior on each supported operating system before production use.

## Deployment requirements and limits

- Zion does not bundle or claim to provide an antivirus engine. The host application must integrate, update, and operate a reputable local scanner and its signature database.
- The adapter should scan archives safely with decompression limits, nested archive limits, timeouts, and protections against parser exploits. Do not execute uploaded files to inspect them.
- Scanner engine errors, timeouts, unsupported formats, encrypted archives, and indeterminate verdicts should be treated as non-clean. The Zion timeout aborts the supplied signal and rejects the upload; the scanner adapter must honor the signal and terminate its underlying process. JavaScript cannot forcibly stop a non-cooperative scanner implementation.
- Keep scanning before client-side encryption so storage peers never need plaintext or file keys. Do not send private keys to scanners or storage nodes.
- The adapter is an integration boundary, not proof of scanner correctness, malware detection coverage, or production readiness. Independently test the selected engine and the complete client upload path.
- Hash blacklists are supplemental indicators only. They are not a substitute for signature-based or behavior-based malware scanning.


## Important trust boundary: client-side scanning is not network-wide enforcement

The ClamAV adapter protects an honest client from accidentally uploading content that its local scanner identifies as non-clean. It is not a remotely enforceable guarantee that every peer in a decentralized network scanned its uploads. A modified or malicious client can bypass this SDK, call a storage node directly, or falsely claim that a scan passed. A client-generated signature or boolean attestation does not prove that a genuine scanner ran or that its signatures were current.

This creates a deliberate privacy/security boundary:

- With end-to-end encryption, ordinary storage peers receive ciphertext and cannot run conventional malware scanning on the original file.
- Scanning plaintext at a central or peer-side gateway requires the plaintext or decryption capability to be disclosed to that gateway, weakening the end-to-end confidentiality model.
- Client-side scanning preserves the plaintext boundary for honest clients, but cannot prevent a determined malicious uploader from bypassing it.

Therefore, do not describe this client-side gate as a network-wide malware firewall. A production network still needs authenticated peer admission, strict quotas, abuse reporting, quarantine and revocation controls, and verified ciphertext integrity. If policy requires enforced malware inspection of every uploaded file, Zion must explicitly adopt a trusted inspection boundary (for example, a user-authorized scanning gateway or a separately threat-modeled confidential-computing design); that trade-off must be visible to users and must not silently expose private keys or plaintext to storage peers.
