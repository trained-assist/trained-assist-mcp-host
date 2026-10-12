#!/usr/bin/env node
// unseal-seed-keys.mjs — decrypt plaintext personal keys sealed in the seed
// workflow run log (Epic #253 I05.c). Local sandbox ops command.
//
//   PRIVATE_KEY_FILE=$HOME/.epic253-secrets/i05c-seed-private.pem \
//     SEALED_RECRUITER_FILE=/tmp/sealed-recruiter.txt \
//     SEALED_SALES_FILE=/tmp/sealed-sales.txt \
//     node scripts/epic253/unseal-seed-keys.mjs
//
// Prints plaintext keys to stdout. Never writes to disk. Caller must capture
// and inject via env (RECRUITER_KEY/SALES_KEY) for the probe; do not persist.
import { constants, createPrivateKey, privateDecrypt } from 'node:crypto';
import { readFileSync } from 'node:fs';

function unseal(privateKey, sealedBase64) {
  return privateDecrypt(
    { key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    Buffer.from(sealedBase64, 'base64'),
  ).toString('utf8');
}

const privateKey = createPrivateKey({ key: readFileSync(process.env.PRIVATE_KEY_FILE, 'utf8') });
for (const [label, file] of [
  ['recruiter', process.env.SEALED_RECRUITER_FILE],
  ['sales', process.env.SEALED_SALES_FILE],
]) {
  if (!file) continue;
  const sealed = readFileSync(file, 'utf8').trim();
  console.log(unseal(privateKey, sealed));
}
