// Inicialização compartilhada do Firebase Admin — usa os módulos modulares
// (firebase-admin/app, /firestore, /auth) em vez do namespace monolítico
// `import admin from 'firebase-admin'`. O import default do pacote monolítico
// se mostrou instável no runtime da Vercel (admin.apps chegando undefined em
// produção, mesmo funcionando local) — os submódulos evitam esse problema.
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';

if (!getApps().length) {
  initializeApp({
    credential: cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    }),
  });
}

export const db = getFirestore();
export const auth = getAuth();
export { FieldValue };
