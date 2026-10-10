import { readFileSync } from 'node:fs';
import { createPrivateKey } from 'node:crypto';
import { requestRemoteWitness } from './request-remote-witness.js';
import { createNotificationRecoveryAnchorWitnessChallengeResponse } from '../src/notification-recovery-anchor-witness-challenge.js';

const [historyPath, tokenFile, publicKeyPath, privateKeyPath, outputPath] = process.argv.slice(2);
const privateKey = createPrivateKey(readFileSync(privateKeyPath, 'utf8'));
const fetchImpl = async (_url, options) => {
  const challenge = JSON.parse(options.body);
  const signedResponse = createNotificationRecoveryAnchorWitnessChallengeResponse({
    challenge,
    witnessId: 'witness-process-race',
    witnessKeyId: 'process-race-key',
    sequence: 1,
    issuedAt: challenge.issuedAt,
    privateKey,
  });
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    text: async () => JSON.stringify(signedResponse),
  };
};

try {
  const result = await requestRemoteWitness({
    endpoint: 'https://witness.example/v1/witness/challenge',
    historyPath, tokenFile, publicKeyPath,
    expectedWitnessId: 'witness-process-race',
    expectedWitnessKeyId: 'process-race-key',
    outputPath, fetchImpl,
  });
  process.stdout.write(JSON.stringify({ ok: true, result }));
} catch (error) {
  process.stderr.write(`${error.code ?? error.name}: ${error.message}`);
  process.exitCode = 1;
}
