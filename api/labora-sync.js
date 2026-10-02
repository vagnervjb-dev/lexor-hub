// Integração servidor-a-servidor com os sistemas da LABORA — Sistema
// Contábil (app desktop, roda local na máquina do usuário) e Ordinatio
// (gestão operacional, Vercel). Nenhum dos dois tem como a LexorHub
// chamar de volta (o desktop é local; o Ordinatio não teria por quê),
// então é sempre o consumidor que busca aqui.
//
// Autenticação própria (chave estática em header), diferente do token
// Firebase usado pelas outras rotas: quem chama não é um usuário logado
// no navegador, é outro backend. Cada consumidor tem a própria chave
// (LABORA_SYNC_API_KEY pro Sistema Contábil, ORDINATIO_SYNC_API_KEY pro
// Ordinatio) — revogável um sem afetar o outro.
//
// Ações (query string ?action=):
//   contabilidades          — lista Usuarios com role=contabilidade (pro
//                            consumidor deixar o usuário escolher qual é
//                            a LABORA, sem precisar decorar um id).
//   processos              — processos de abertura de empresa de uma
//                            contabilidade, ainda não importados POR ESSE
//                            CONSUMIDOR, que já têm CNPJ ativo: etapa
//                            "Concluído" OU, antes disso, já com o Cartão
//                            CNPJ anexado nos documentos do processo (a
//                            Receita libera o CNPJ na etapa "Junta
//                            Comercial", bem antes do processo fechar —
//                            esperar o "Concluído" formal atrasa a
//                            importação sem necessidade). Se o processo
//                            não tem o número do CNPJ digitado no campo,
//                            lê o Cartão CNPJ anexado com IA (Claude
//                            visão, requer ANTHROPIC_API_KEY) e grava o
//                            número de volta no processo. Requer
//                            ?contabilidadeId=. Aceita ?consumidor=ordinatio
//                            (padrão: sistema-contabil).
//   fluxos                 — os 3 fluxos de etapas (abertura, alteração,
//                            encerramento) com SLA, descrição e checklist
//                            de cada etapa: o que estiver salvo na coleção
//                            Firestore `fluxos` (edições feitas na tela
//                            Fluxos), senão o padrão. Só leitura — o
//                            Ordinatio espelha, quem edita é a LexorHub.
//   processos-andamento    — TODOS os processos de uma contabilidade (os
//                            3 tipos, em andamento e concluídos) com etapa
//                            atual, checklist da etapa, histórico e
//                            responsáveis, pro Ordinatio espelhar como
//                            tarefas. Só leitura (não marca nada como
//                            importado). Requer ?contabilidadeId=.
//   marcar-importado (POST) — marca um processo como já importado POR ESSE
//                            CONSUMIDOR (campo próprio — Sistema Contábil
//                            e Ordinatio importam de forma independente,
//                            um não esconde o processo do outro). Aceita
//                            {processoId, consumidor}.
import { getFirebaseAdmin } from './_lib/firebase-admin.js';
import { createStructuredMessage } from './_lib/anthropic.js';
import { FLUXOS_PADRAO } from './_lib/fluxos-padrao.js';

// Cada consumidor grava sua própria marca de "já importei" — importar num
// sistema não pode esconder o processo do outro.
const CAMPO_IMPORTADO = {
  'sistema-contabil': 'importadoLabora',
  ordinatio: 'importadoOrdinatio',
};

function consumidorDe(req) {
  const valor = req.query?.consumidor || (req.body || {}).consumidor;
  return CAMPO_IMPORTADO[valor] ? valor : 'sistema-contabil';
}

function autenticado(req) {
  const chave = req.headers['x-api-key'];
  if (!chave) return false;
  return chave === process.env.LABORA_SYNC_API_KEY || chave === process.env.ORDINATIO_SYNC_API_KEY;
}

async function listarContabilidades(db) {
  const snap = await db.collection('Usuarios').get();
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .filter((u) => u.role === 'contabilidade')
    .map((u) => ({ id: u.id, nome: u.nome || u.email || u.id }));
}

// Normaliza (sem acento, minúsculo) pra comparar nome de arquivo livre —
// quem anexa digita o nome manualmente. Na prática o arquivo às vezes nem
// tem "cartão" no nome, só "CNPJ.pdf" mesmo — então o critério é apenas
// ter "cnpj" no nome (cobre "CNPJ.pdf", "Cartão CNPJ.pdf",
// "cartao_cnpj_empresa.png" etc.).
function normalizar(txt) {
  return String(txt || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

function documentoCartaoCnpj(docs) {
  return docs.find((d) => normalizar(d.nome).includes('cnpj')) || null;
}

const MEDIA_TYPES_SUPORTADOS = {
  'application/pdf': 'application/pdf',
  'image/jpeg': 'image/jpeg',
  'image/jpg': 'image/jpeg',
  'image/png': 'image/png',
  'image/webp': 'image/webp',
};

const cnpjSchema = {
  type: 'object',
  properties: { cnpj: { anyOf: [{ type: 'string' }, { type: 'null' }] } },
  required: ['cnpj'],
  additionalProperties: false,
};

// Lê o Cartão CNPJ anexado (documento oficial da Receita Federal) com
// Claude (visão) e extrai só o número — mesmo mecanismo já usado em
// extrair-dados-processo.js, mas sem exigir login/idToken (quem chama
// aqui é outro backend, via x-api-key) e focado num único campo. Se não
// der pra ler (sem ANTHROPIC_API_KEY, formato não suportado, falha da
// IA), devolve null e quem chamou segue mostrando "CNPJ ausente".
async function extrairCnpjDoDocumento(documento) {
  const mediaType = MEDIA_TYPES_SUPORTADOS[documento.tipo];
  if (!mediaType) return null;
  try {
    const resp = await fetch(documento.url);
    if (!resp.ok) return null;
    const buffer = Buffer.from(await resp.arrayBuffer());
    const data = buffer.toString('base64');
    const bloco = mediaType === 'application/pdf'
      ? { type: 'document', source: { type: 'base64', media_type: mediaType, data } }
      : { type: 'image', source: { type: 'base64', media_type: mediaType, data } };

    const valores = await createStructuredMessage({
      messages: [{
        role: 'user',
        content: [
          bloco,
          {
            type: 'text',
            text: 'Este é o Cartão CNPJ (Comprovante de Inscrição e de Situação Cadastral) de uma empresa. '
              + 'Extraia só o número do CNPJ, no formato XX.XXX.XXX/XXXX-XX. Se não conseguir identificar '
              + 'com certeza, retorne null — nunca invente.',
          },
        ],
      }],
      schema: cnpjSchema,
    });

    const cnpj = String(valores?.cnpj || '').replace(/\D/g, '');
    return cnpj.length === 14 ? cnpj : null;
  } catch (e) {
    console.warn(`Falha ao extrair CNPJ do documento ${documento.nome}:`, e.message);
    return null;
  }
}

async function listarProcessosComCnpjAtivo(db, contabilidadeId, campoImportado) {
  const snap = await db.collection('processos')
    .where('contabilidadeId', '==', contabilidadeId)
    .where('fluxoKey', '==', 'abertura')
    .get();

  // Não exige mais p.cnpj preenchido pra aparecer na lista: o campo do
  // processo às vezes fica vazio mesmo com o Cartão CNPJ já anexado (quem
  // está de olho no documento nem sempre digita o número de volta no
  // processo). Quando falta, tenta ler o número direto do PDF/imagem
  // anexado via IA — e grava de volta no processo pra não precisar ler de
  // novo a cada consulta.
  const candidatos = snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .filter((p) => !p[campoImportado]);

  const resultado = [];
  for (const p of candidatos) {
    const concluido = p.etapa === 'Concluído';
    let cnpj = p.cnpj || '';
    let documentosDoProcesso = null;

    if (!concluido || !cnpj) {
      const docsSnap = await db.collection('processos').doc(p.id).collection('documentos').get();
      documentosDoProcesso = docsSnap.docs.map((d) => d.data());
    }

    const cartaoCnpj = concluido ? true : !!documentoCartaoCnpj(documentosDoProcesso || []);
    if (!concluido && !cartaoCnpj) continue;

    if (!cnpj && documentosDoProcesso) {
      const documento = documentoCartaoCnpj(documentosDoProcesso);
      if (documento) {
        const extraido = await extrairCnpjDoDocumento(documento);
        if (extraido) {
          cnpj = extraido;
          await db.collection('processos').doc(p.id).update({ cnpj: extraido });
        }
      }
    }

    resultado.push({
      id: p.id,
      empresa: p.empresa || '',
      cnpj,
      naturezaJuridica: p.naturezaJuridica || '',
      regimeTributario: p.regimeTributario || '',
      capitalSocial: p.capitalSocial || '',
      cnae: p.cnae || '',
      cnaeSecundarios: p.cnaeSecundarios || '',
      endereco: p.endereco || '',
      cidade: p.cidade || '',
      uf: p.uf || '',
      cep: p.cep || '',
      socios: p.socios || [],
      criadoEm: p.criadoEm || '',
      etapa: p.etapa || '',
      concluido,
    });
  }
  return resultado;
}

async function listarFluxos(db) {
  const fluxos = {};
  for (const [key, padrao] of Object.entries(FLUXOS_PADRAO)) {
    const snap = await db.collection('fluxos').doc(key).get();
    const salvo = snap.exists ? snap.data() : null;
    fluxos[key] = {
      titulo: padrao.titulo,
      etapas: Array.isArray(salvo?.etapas) && salvo.etapas.length ? salvo.etapas : padrao.etapas,
      atualizadoEm: salvo?.atualizadoEm || null,
      personalizado: !!salvo,
    };
  }
  return fluxos;
}

// Só os campos que o Ordinatio precisa pra espelhar — sem sócios/CPF,
// WhatsApp ou e-mail do cliente final.
async function listarProcessosEmAndamento(db, contabilidadeId) {
  const snap = await db.collection('processos')
    .where('contabilidadeId', '==', contabilidadeId)
    .get();

  return snap.docs.map((d) => {
    const p = d.data();
    return {
      id: d.id,
      empresa: p.empresa || '',
      cnpj: p.cnpj || '',
      tipo: p.tipo || '',
      fluxoKey: p.fluxoKey || 'abertura',
      etapa: p.etapa || '',
      etapaIniciadaEm: p.etapaIniciadaEm || p.criadoEm || null,
      status: p.status || 'andamento',
      criadoEm: p.criadoEm || null,
      criadoPorNome: p.criadoPorNome || '',
      responsavel: p.responsavel || '',
      respLexor: p.respLexor || '',
      obs: p.obs || '',
      cidade: p.cidade || '',
      uf: p.uf || '',
      tarefas: Array.isArray(p.tarefas) ? p.tarefas.map((t) => ({ feita: !!t?.feita, data: t?.data || null })) : [],
      historico: (Array.isArray(p.historico) ? p.historico : []).slice(-30).map((h) => ({
        tipo: h.tipo || '',
        etapa: h.etapa || '',
        proxEtapa: h.proxEtapa || '',
        obs: h.obs || '',
        resp: h.resp || '',
        data: h.data || null,
      })),
    };
  });
}

export default async function handler(req, res) {
  if (!autenticado(req)) return res.status(401).json({ error: 'nao_autenticado' });

  let db;
  try {
    ({ db } = await getFirebaseAdmin());
  } catch (e) {
    console.error('Falha ao inicializar Firebase Admin:', e.message);
    return res.status(500).json({ error: 'configuracao_firebase_invalida', detalhe: e.message });
  }

  const action = req.query?.action;

  if (req.method === 'GET' && action === 'contabilidades') {
    const contabilidades = await listarContabilidades(db);
    return res.status(200).json({ contabilidades });
  }

  if (req.method === 'GET' && action === 'fluxos') {
    return res.status(200).json({ fluxos: await listarFluxos(db) });
  }

  if (req.method === 'GET' && action === 'processos-andamento') {
    const contabilidadeId = req.query?.contabilidadeId;
    if (!contabilidadeId) return res.status(400).json({ error: 'contabilidadeId_obrigatorio' });
    return res.status(200).json({ processos: await listarProcessosEmAndamento(db, contabilidadeId) });
  }

  if (req.method === 'GET' && action === 'processos') {
    const contabilidadeId = req.query?.contabilidadeId;
    if (!contabilidadeId) return res.status(400).json({ error: 'contabilidadeId_obrigatorio' });
    const campoImportado = CAMPO_IMPORTADO[consumidorDe(req)];
    const processos = await listarProcessosComCnpjAtivo(db, contabilidadeId, campoImportado);
    return res.status(200).json({ processos });
  }

  if (req.method === 'POST' && action === 'marcar-importado') {
    const { processoId } = req.body || {};
    if (!processoId) return res.status(400).json({ error: 'processoId_obrigatorio' });
    const campoImportado = CAMPO_IMPORTADO[consumidorDe(req)];
    const ref = db.collection('processos').doc(processoId);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: 'processo_nao_encontrado' });
    await ref.update({ [campoImportado]: true, [`${campoImportado}Em`]: new Date().toISOString() });
    return res.status(200).json({ ok: true });
  }

  return res.status(400).json({ error: 'acao_invalida' });
}
