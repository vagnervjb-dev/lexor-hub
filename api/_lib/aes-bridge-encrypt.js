// Formato AES Bridge GCM implementado com o crypto nativo do Node:
// salt(16) + nonce(12) + ciphertext + authTag(16), tudo em Base64.
//
// O pacote aes-bridge publica simultaneamente ESM/CJS/UMD e o empacotador da
// Vercel tentou executar o build ESM como CommonJS (Unexpected token 'export').
// Usar somente primitivas nativas elimina esse conflito sem mudar o formato
// exigido pela Infosimples.
import { createCipheriv, pbkdf2Sync, randomBytes } from 'node:crypto';

async function encrypt(data, passphrase) {
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const key = pbkdf2Sync(Buffer.from(passphrase, 'utf8'), salt, 100_000, 32, 'sha256');
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const plaintext = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return Buffer.concat([salt, nonce, ciphertext, authTag]).toString('base64');
}

export async function getEncrypt() {
  return encrypt;
}
