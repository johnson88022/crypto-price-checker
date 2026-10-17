import { createECDH, randomBytes } from 'node:crypto';

let ecdh;
while (true) {
  try {
    ecdh = createECDH('prime256v1');
    ecdh.setPrivateKey(randomBytes(32));
    break;
  } catch {
    // Retry if the random scalar is outside the curve's valid range.
  }
}
const b64url = bytes => Buffer.from(bytes).toString('base64url');
console.log('VAPID_PUBLIC_KEY=' + b64url(ecdh.getPublicKey(null, 'uncompressed')));
console.log('VAPID_PRIVATE_KEY=' + b64url(ecdh.getPrivateKey()));
