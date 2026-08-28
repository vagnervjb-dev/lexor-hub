// Extrai dados de documentos (RG, CPF, comprovante de endereço, cartão CNPJ etc.)
// usando Claude (visão) e devolve os valores para preencher as variáveis de um
// modelo de contrato social. Dois modos: { processoId, documentoIds } lê a
// subcoleção de documentos de um processo já salvo; { documentos: [{url,tipo}] }
// é o modo avulso, usado sem processo vinculado (upload temporário no Storage).
// Requer ANTHROPIC_API_KEY nas env vars (Vercel), além das já usadas pelo
// firebase-admin (FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY).
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { getFirebaseAdmin } from './_lib/firebase-admin.js';

const anthropic = new Anthropic();

const MEDIA_TYPES_SUPORTADOS = {
  'application/pdf': 'application/pdf',
  'image/jpeg': 'image/jpeg',
  'image/jpg': 'image/jpeg',
  'image/png': 'image/png',
  'image/webp': 'image/webp',
};

// Restringe fetch a URLs do nosso próprio Firebase Storage — evita que o endpoint
// vire um proxy de fetch pra URL arbitrária no modo avulso (documentos enviados
// direto pelo cliente, sem passar por uma subcoleção validada no Firestore).
function isFirebaseStorageUrl(url) {
  try { return new URL(url).hostname === 'firebasestorage.googleapis.com'; } catch { return false; }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

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
  } catch {
    return res.status(401).json({ error: 'token_invalido' });
  }

  const { processoId, modeloId, documentoIds, documentos: documentosAvulso } = req.body || {};
  if (!modeloId) return res.status(400).json({ error: 'parametros_invalidos' });

  const modeloSnap = await db.collection('modelosContrato').doc(modeloId).get();
  if (!modeloSnap.exists) return res.status(404).json({ error: 'modelo_nao_encontrado' });
  const variaveis = modeloSnap.data().variaveis || [];
  if (variaveis.length === 0) return res.status(400).json({ error: 'modelo_sem_variaveis' });

  let documentos;
  if (Array.isArray(documentosAvulso) && documentosAvulso.length > 0) {
    // Modo avulso — sem processo vinculado, documentos vêm direto do cliente.
    documentos = documentosAvulso.filter(
      (d) => d && typeof d.url === 'string' && isFirebaseStorageUrl(d.url) && typeof d.tipo === 'string'
    );
    if (documentos.length === 0) return res.status(400).json({ error: 'documentos_invalidos' });
  } else if (processoId && Array.isArray(documentoIds) && documentoIds.length > 0) {
    const docSnaps = await Promise.all(
      documentoIds.map((id) =>
        db.collection('processos').doc(processoId).collection('documentos').doc(id).get()
      )
    );
    documentos = docSnaps.filter((d) => d.exists).map((d) => d.data());
    if (documentos.length === 0) return res.status(404).json({ error: 'documentos_nao_encontrados' });
  } else {
    return res.status(400).json({ error: 'parametros_invalidos' });
  }

  const contentBlocks = [];
  for (const documento of documentos) {
    const mediaType = MEDIA_TYPES_SUPORTADOS[documento.tipo];
    if (!mediaType) continue; // pula .docx/.xlsx anexados — só lê imagem/PDF
    try {
      const resp = await fetch(documento.url);
      if (!resp.ok) continue;
      const buffer = Buffer.from(await resp.arrayBuffer());
      const data = buffer.toString('base64');
      contentBlocks.push(
        mediaType === 'application/pdf'
          ? { type: 'document', source: { type: 'base64', media_type: mediaType, data } }
          : { type: 'image', source: { type: 'base64', media_type: mediaType, data } }
      );
    } catch (e) {
      console.warn(`Erro ao baixar documento ${documento.nome}:`, e.message);
    }
  }
  if (contentBlocks.length === 0) return res.status(400).json({ error: 'nenhum_documento_legivel' });

  contentBlocks.push({
    type: 'text',
    text:
      `Estes são documentos de identificação/comprovação de um cliente de uma contabilidade ` +
      `(ex: RG, CPF, comprovante de endereço, cartão CNPJ), usados para preencher um contrato social. ` +
      `Extraia com precisão os seguintes campos a partir do conteúdo dos documentos acima. ` +
      `Se um campo não aparecer em nenhum documento, retorne null para ele — nunca invente um valor. ` +
      `Campos a extrair: ${variaveis.join(', ')}.`,
  });

  const schema = z.object(Object.fromEntries(variaveis.map((v) => [v, z.string().nullable()])));

  let response;
  try {
    response = await anthropic.messages.parse({
      model: 'claude-opus-5',
      max_tokens: 4096,
      messages: [{ role: 'user', content: contentBlocks }],
      output_config: { format: zodOutputFormat(schema) },
    });
  } catch (e) {
    console.error('Erro ao chamar Claude:', e.message);
    return res.status(502).json({ error: 'falha_ia', detalhe: e.message });
  }

  if (!response.parsed_output) {
    return res.status(502).json({ error: 'extracao_sem_resultado' });
  }

  return res.status(200).json({ valores: response.parsed_output });
}
