// Inicialização compartilhada e preguiçosa do Firebase Admin.
//
// Não inicialize o SDK no carregamento do módulo: qualquer variável ausente ou
// chave privada malformada derrubaria a função antes de o handler conseguir
// responder. Isso aparece na Vercel apenas como FUNCTION_INVOCATION_FAILED e
// torna o diagnóstico desnecessariamente difícil. Os imports também são
// dinâmicos para que o empacotador da Vercel não avalie firebase-admin antes
// de o handler começar.

let servicesPromise;
const EXPECTED_PROJECT_ID = 'lexorhub-1e7cb';

function cleanEnvValue(value) {
  const trimmed = value.trim();
  const quote = trimmed[0];
  if ((quote === '"' || quote === "'") && trimmed.at(-1) === quote) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

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
  const required = ['FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY'];
  const missing = required.filter((key) => !process.env[key]?.trim());
  if (missing.length) {
    throw new Error(`Variáveis ausentes na Vercel: ${missing.join(', ')}`);
  }

  // O projectId não é segredo e já faz parte da configuração pública do
  // frontend. Mantê-lo também como env var permitiu que um hash fosse colado
  // por engano na Vercel, fazendo todo token legítimo falhar por audience.
  const configuredProjectId = process.env.FIREBASE_PROJECT_ID
    ? cleanEnvValue(process.env.FIREBASE_PROJECT_ID)
    : null;
  if (configuredProjectId && configuredProjectId !== EXPECTED_PROJECT_ID) {
    console.warn(
      `FIREBASE_PROJECT_ID ignorado: recebido "${configuredProjectId}", usando "${EXPECTED_PROJECT_ID}".`
    );
  }
  const projectId = EXPECTED_PROJECT_ID;
  const clientEmail = cleanEnvValue(process.env.FIREBASE_CLIENT_EMAIL);
  const privateKey = cleanEnvValue(process.env.FIREBASE_PRIVATE_KEY).replace(/\\n/g, '\n');

  const [{ initializeApp, cert, getApps }, { getFirestore, FieldValue }, { getAuth }] =
    await Promise.all([
      import('firebase-admin/app'),
      import('firebase-admin/firestore'),
      import('firebase-admin/auth'),
    ]);

  if (!getApps().length) {
    initializeApp({
      credential: cert({
        projectId,
        clientEmail,
        privateKey,
      }),
    });
  }

  return {
    db: getFirestore(),
    auth: getAuth(),
    FieldValue,
  };
}
