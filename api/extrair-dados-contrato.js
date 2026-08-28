// Extrai dados de documentos (RG, CPF, comprovante de endereço, cartão CNPJ etc.)
// usando Claude (visão) e devolve os valores para preencher as variáveis de um
// modelo de contrato social. Dois modos: { processoId, documentoIds } lê a
// subcoleção de documentos de um processo já salvo; { documentos: [{url,tipo}] }
// é o modo avulso, usado sem processo vinculado (upload temporário no Storage).
// Requer ANTHROPIC_API_KEY nas env vars (Vercel), além das já usadas pelo
// firebase-admin (FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY).
import { getFirebaseAdmin } from './_lib/firebase-admin.js';
import { assertAnthropicConfigured, createJsonMessage } from './_lib/anthropic.js';

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

  const temCampoForo = variaveis.some((variavel) =>
    /(^|_)(foro|comarca)(_|$)/i.test(variavel)
  );
  const camposInternosSede = temCampoForo
    ? ['__cidade_sede', '__estado_sede', '__uf_sede']
    : [];
  const camposSolicitados = [...variaveis, ...camposInternosSede];

  contentBlocks.push({
    type: 'text',
    text:
      `Estes são documentos de identificação/comprovação de um cliente de uma contabilidade ` +
      `(ex: RG, CPF, comprovante de endereço, cartão CNPJ), usados para preencher um contrato social. ` +
      `Extraia com precisão os seguintes campos a partir do conteúdo dos documentos acima. ` +
      `Se um campo não aparecer em nenhum documento, retorne uma string vazia para ele — nunca invente um valor. ` +
      (temCampoForo
        ? `REGRA OBRIGATÓRIA DE FORO: identifique a cidade e o estado/UF do endereço da sede da empresa ` +
          `no comprovante de endereço empresarial. O foro deve ser sempre essa cidade e esse estado, nunca ` +
          `o endereço residencial de um sócio. Preencha __cidade_sede, __estado_sede e __uf_sede apenas com ` +
          `os dados da sede. Se o modelo tiver um único campo de foro ou comarca, use o formato Cidade/UF. ` +
          `Se houver campos separados de cidade, estado ou UF do foro, preencha cada parte separadamente. `
        : '') +
      `Responda somente com um objeto JSON válido, sem markdown e sem explicações. ` +
      `O objeto deve conter exatamente todas as chaves listadas, e todos os valores devem ser strings. ` +
      `Campos a extrair: ${camposSolicitados.join(', ')}.`,
  });

  let extraidos;
  try {
    extraidos = await createJsonMessage({
      messages: [{ role: 'user', content: contentBlocks }],
      maxTokens: 8192,
    });
  } catch (e) {
    console.error('Erro ao chamar Claude:', e.message);
    return res.status(502).json({ error: 'falha_ia', detalhe: e.message });
  }

  if (!extraidos || typeof extraidos !== 'object' || Array.isArray(extraidos)) {
    return res.status(502).json({ error: 'extracao_sem_resultado' });
  }

  // O modo de JSON livre evita que a gramática rígida da Anthropic exceda o
  // limite com modelos grandes. Normalizamos a resposta aqui para garantir que
  // a tela receba somente as variáveis do modelo, todas como strings.
  const texto = (valor) => {
    if (typeof valor === 'string') return valor.trim();
    if (typeof valor === 'number' || typeof valor === 'boolean') return String(valor);
    return '';
  };
  const sede = {
    cidade: texto(extraidos.__cidade_sede),
    estado: texto(extraidos.__estado_sede),
    uf: texto(extraidos.__uf_sede).toUpperCase(),
  };

  const valores = Object.fromEntries(
    variaveis.map((variavel) => {
      let valor = texto(extraidos[variavel]);
      const nomeCampo = variavel.toLowerCase();
      const campoForo = /(^|_)(foro|comarca)(_|$)/.test(nomeCampo);

      // Reforço determinístico: mesmo que a IA devolva outro foro, quando o
      // comprovante empresarial informa a sede, estes campos são derivados
      // exclusivamente dela.
      if (campoForo && (sede.cidade || sede.estado || sede.uf)) {
        if (/(^|_)uf(_|$)/.test(nomeCampo)) valor = sede.uf || sede.estado;
        else if (/(^|_)estado(_|$)/.test(nomeCampo)) valor = sede.estado || sede.uf;
        else if (/(^|_)(cidade|municipio)(_|$)/.test(nomeCampo)) valor = sede.cidade;
        else valor = [sede.cidade, sede.uf || sede.estado].filter(Boolean).join('/');
      }

      return [variavel, valor];
    })
  );

  return res.status(200).json({ valores });
}
