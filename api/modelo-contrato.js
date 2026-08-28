// Entrega um modelo .docx por uma rota autenticada e no mesmo domínio do
// Lexor. O navegador não precisa acessar o Firebase Storage diretamente, o que
// evita bloqueios de CORS na pré-visualização e na geração do contrato.
import { getFirebaseAdmin } from './_lib/firebase-admin.js';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const MAX_MODEL_SIZE = 25 * 1024 * 1024;

function isAllowedStorageUrl(value) {
  try {
    const { protocol, hostname } = new URL(value);
    return protocol === 'https:' && (
      hostname === 'firebasestorage.googleapis.com' ||
      hostname === 'storage.googleapis.com'
    );
  } catch {
    return false;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });

  const authHeader = req.headers.authorization || '';
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!idToken) return res.status(401).json({ error: 'sem_token' });

  let db;
  let auth;
  try {
    ({ db, auth } = await getFirebaseAdmin());
  } catch (e) {
    console.error('Falha ao inicializar Firebase Admin:', e.message);
    return res.status(500).json({ error: 'configuracao_firebase_invalida', detalhe: e.message });
  }

  try {
    await auth.verifyIdToken(idToken);
  } catch (e) {
    return res.status(401).json({ error: 'token_invalido', detalhe: e.code || e.message });
  }

  const modeloId = typeof req.query.modeloId === 'string' ? req.query.modeloId.trim() : '';
  if (!modeloId) return res.status(400).json({ error: 'modelo_id_ausente' });

  try {
    const modeloSnap = await db.collection('modelosContrato').doc(modeloId).get();
    if (!modeloSnap.exists) return res.status(404).json({ error: 'modelo_nao_encontrado' });

    const modelo = modeloSnap.data();
    if (!isAllowedStorageUrl(modelo.url)) {
      return res.status(400).json({ error: 'url_modelo_invalida' });
    }

    const storageResponse = await fetch(modelo.url, { redirect: 'follow' });
    if (!storageResponse.ok) {
      throw new Error(`Firebase Storage respondeu HTTP ${storageResponse.status}`);
    }

    const contentLength = Number(storageResponse.headers.get('content-length') || 0);
    if (contentLength > MAX_MODEL_SIZE) {
      return res.status(413).json({ error: 'modelo_muito_grande' });
    }

    const buffer = Buffer.from(await storageResponse.arrayBuffer());
    if (buffer.length > MAX_MODEL_SIZE) {
      return res.status(413).json({ error: 'modelo_muito_grande' });
    }

    res.setHeader('Content-Type', DOCX_MIME);
    res.setHeader('Content-Length', String(buffer.length));
    res.setHeader('Cache-Control', 'private, no-store');
    return res.status(200).send(buffer);
  } catch (e) {
    console.error('Erro ao carregar modelo de contrato:', e.message);
    return res.status(502).json({ error: 'falha_ao_carregar_modelo', detalhe: e.message });
  }
}
