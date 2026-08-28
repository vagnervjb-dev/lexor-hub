// Lê os documentos já anexados a um processo (RG, CPF, comprovante de endereço,
// cartão CNPJ, contrato social etc.) e extrai, via Claude (visão), os dados da
// empresa e o quadro societário — pra pré-preencher o processo automaticamente,
// em vez de digitar tudo à mão em "Coleta de dados".
// Requer ANTHROPIC_API_KEY nas env vars (Vercel), além das já usadas pelo
// firebase-admin (FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY).
import { getFirebaseAdmin } from './_lib/firebase-admin.js';
import { assertAnthropicConfigured, createStructuredMessage } from './_lib/anthropic.js';

const MEDIA_TYPES_SUPORTADOS = {
  'application/pdf': 'application/pdf',
  'image/jpeg': 'image/jpeg',
  'image/jpg': 'image/jpeg',
  'image/png': 'image/png',
  'image/webp': 'image/webp',
};

const nullableString = { anyOf: [{ type: 'string' }, { type: 'null' }] };
const dadosProcessoSchema = {
  type: 'object',
  properties: {
    cnpj: nullableString,
    naturezaJuridica: nullableString,
    regimeTributario: nullableString,
    capitalSocial: nullableString,
    cnae: nullableString,
    endereco: nullableString,
    cidade: nullableString,
    cep: nullableString,
    whatsapp: nullableString,
    emailCliente: nullableString,
    socios: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          nome: { type: 'string' },
          cpf: nullableString,
          administrador: { anyOf: [{ type: 'boolean' }, { type: 'null' }] },
          participacao: nullableString,
        },
        required: ['nome', 'cpf', 'administrador', 'participacao'],
        additionalProperties: false,
      },
    },
  },
  required: [
    'cnpj',
    'naturezaJuridica',
    'regimeTributario',
    'capitalSocial',
    'cnae',
    'endereco',
    'cidade',
    'cep',
    'whatsapp',
    'emailCliente',
    'socios',
  ],
  additionalProperties: false,
};

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
  } catch (e) {
    console.error('Token Firebase rejeitado:', e.code || e.message);
    return res.status(401).json({ error: 'token_invalido', detalhe: e.code || e.message });
  }

  try {
    assertAnthropicConfigured();
  } catch (e) {
    console.error('Falha ao inicializar Anthropic:', e.message);
    return res.status(500).json({ error: 'configuracao_ia_invalida', detalhe: e.message });
  }

  const { processoId, documentoIds } = req.body || {};
  if (!processoId || !Array.isArray(documentoIds) || documentoIds.length === 0) {
    return res.status(400).json({ error: 'parametros_invalidos' });
  }

  const docSnaps = await Promise.all(
    documentoIds.map((id) =>
      db.collection('processos').doc(processoId).collection('documentos').doc(id).get()
    )
  );
  const documentos = docSnaps.filter((d) => d.exists).map((d) => d.data());
  if (documentos.length === 0) return res.status(404).json({ error: 'documentos_nao_encontrados' });

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
      `Estes são documentos de um processo de legalização de empresa (RG, CPF, comprovante de ` +
      `endereço, cartão CNPJ, contrato social, entre outros). Extraia os dados da empresa e o ` +
      `quadro societário completo (todos os sócios encontrados nos documentos). ` +
      `Se um campo não aparecer em nenhum documento, retorne null (ou lista vazia para sócios) — ` +
      `nunca invente um valor. "participacao" é o percentual de participação societária, se constar.`,
  });

  let valores;
  try {
    valores = await createStructuredMessage({
      messages: [{ role: 'user', content: contentBlocks }],
      schema: dadosProcessoSchema,
    });
  } catch (e) {
    console.error('Erro ao chamar Claude:', e.message);
    return res.status(502).json({ error: 'falha_ia', detalhe: e.message });
  }

  if (!valores || typeof valores !== 'object' || Array.isArray(valores)) {
    return res.status(502).json({ error: 'extracao_sem_resultado' });
  }

  return res.status(200).json({ valores });
}
