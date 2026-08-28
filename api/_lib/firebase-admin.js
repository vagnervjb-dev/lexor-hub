// Inicialização compartilhada e preguiçosa do Firebase Admin.
//
// Não inicialize o SDK no carregamento do módulo: qualquer variável ausente ou
// chave privada malformada derrubaria a função antes de o handler conseguir
// responder. Isso aparece na Vercel apenas como FUNCTION_INVOCATION_FAILED e
// torna o diagnóstico desnecessariamente difícil.
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';

let services;

export function getFirebaseAdmin() {
  if (services) return services;

  const required = ['FIREBASE_PROJECT_ID', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY'];
  const missing = required.filter((key) => !process.env[key]?.trim());
  if (missing.length) {
    throw new Error(`Variáveis ausentes na Vercel: ${missing.join(', ')}`);
  }

  if (!getApps().length) {
    initializeApp({
      credential: cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      }),
    });
  }

  services = {
    db: getFirestore(),
    auth: getAuth(),
  };
  return services;
}

export { FieldValue };
