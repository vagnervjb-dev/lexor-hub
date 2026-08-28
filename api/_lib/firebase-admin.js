// Inicialização compartilhada e preguiçosa do Firebase Admin.
//
// Não inicialize o SDK no carregamento do módulo: qualquer variável ausente ou
// chave privada malformada derrubaria a função antes de o handler conseguir
// responder. Isso aparece na Vercel apenas como FUNCTION_INVOCATION_FAILED e
// torna o diagnóstico desnecessariamente difícil. Os imports também são
// dinâmicos para que o empacotador da Vercel não avalie firebase-admin antes
// de o handler começar.

let servicesPromise;

export function getFirebaseAdmin() {
  if (!servicesPromise) {
    servicesPromise = initializeFirebaseAdmin().catch((error) => {
      servicesPromise = undefined;
      throw error;
    });
  }
  return servicesPromise;
}

async function initializeFirebaseAdmin() {
  const required = ['FIREBASE_PROJECT_ID', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY'];
  const missing = required.filter((key) => !process.env[key]?.trim());
  if (missing.length) {
    throw new Error(`Variáveis ausentes na Vercel: ${missing.join(', ')}`);
  }

  const [{ initializeApp, cert, getApps }, { getFirestore, FieldValue }, { getAuth }] =
    await Promise.all([
      import('firebase-admin/app'),
      import('firebase-admin/firestore'),
      import('firebase-admin/auth'),
    ]);

  if (!getApps().length) {
    initializeApp({
      credential: cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      }),
    });
  }

  return {
    db: getFirestore(),
    auth: getAuth(),
    FieldValue,
  };
}
