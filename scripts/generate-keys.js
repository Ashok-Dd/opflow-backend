// Prints fresh secrets for .env / host secrets: the Ed25519 token keys, the password pepper and the data key.
// Run once per environment:  npm run keys:generate
// Paste the output into the host's secrets (never into git). Losing PASSWORD_PEPPER or DATA_ENCRYPTION_KEY
// means every password must be reset and every admin authenticator set up again: keep a safe copy.
const { generateKeyPairSync, randomBytes } = require('node:crypto');

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const b64 = (s) => Buffer.from(s).toString('base64');
const month = new Date().toISOString().slice(0, 7);

console.log(`JWT_ACCESS_PRIVATE_KEY_B64=${b64(privateKey.export({ type: 'pkcs8', format: 'pem' }))}`);
console.log(`JWT_ACCESS_PUBLIC_KEY_B64=${b64(publicKey.export({ type: 'spki', format: 'pem' }))}`);
console.log(`JWT_KEY_ID=${month}`);
console.log(`PASSWORD_PEPPER=${randomBytes(32).toString('base64')}`);
console.log(`DATA_ENCRYPTION_KEY=${randomBytes(32).toString('base64')}`);
