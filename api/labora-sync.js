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
//                            tarefas, incluindo os documentos anexados
//                            ao processo (nome, link de download, etapa em
//                            que foram enviados). Só leitura (não marca
//                            nada como importado). Requer
//                            ?contabilidadeId=.
//   extrair-certidao (POST) — lê com IA (Claude visão) a Certidão de
//                            Inteiro Teor anexada ao processo e devolve
//                            SÓ dados da empresa (razão social, nome
//                            fantasia, data de abertura, endereço) — nada
//                            de sócios/CPF. O Ordinatio mostra pra
//                            conferência antes de preencher o cadastro.
//                            Aceita {processoId, contabilidadeId}.
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

const certidaoSchema = {
  type: 'object',
  properties: {
    razaoSocial: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    nomeFantasia: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    dataAbertura: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    cep: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    logradouro: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    numero: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    complemento: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    bairro: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    cidade: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    uf: { anyOf: [{ type: 'string' }, { type: 'null' }] },
  },
  required: ['razaoSocial', 'nomeFantasia', 'dataAbertura', 'cep', 'logradouro', 'numero', 'complemento', 'bairro', 'cidade', 'uf'],
  additionalProperties: false,
};

function textoOuNull(v) {
  const t = String(v ?? '').trim();
  return t || null;
}

// Lê a Certidão de Inteiro Teor (Junta Comercial) anexada ao processo.
// Só campos da empresa — a certidão traz CPF/endereço dos sócios, que
// ficam de fora de propósito (nem entram no schema).
async function extrairCertidao(db, processoId, contabilidadeId) {
  const ref = db.collection('processos').doc(processoId);
  const snap = await ref.get();
  if (!snap.exists) return { status: 404, body: { error: 'processo_nao_encontrado' } };
  // A chave do consumidor vale pra qualquer contabilidade — confere que o
  // processo é da que o consumidor está configurado pra enxergar.
  if (snap.data().contabilidadeId !== contabilidadeId) return { status: 403, body: { error: 'processo_de_outra_contabilidade' } };

  const docs = (await ref.collection('documentos').get()).docs.map((d) => d.data());
  const certidoes = docs
    .filter((d) => {
      const n = normalizar(d.nome);
      return n.includes('inteiro') && n.includes('teor');
    })
    .sort((a, b) => String(b.criadoEm).localeCompare(String(a.criadoEm)));
  const documento = certidoes[0];
  if (!documento) return { status: 404, body: { error: 'certidao_nao_encontrada' } };

  const mediaType = MEDIA_TYPES_SUPORTADOS[documento.tipo];
  if (!mediaType) return { status: 400, body: { error: 'formato_nao_suportado', detalhe: documento.tipo } };

  const resp = await fetch(documento.url);
  if (!resp.ok) return { status: 502, body: { error: 'falha_ao_baixar_documento', detalhe: `HTTP ${resp.status}` } };
  const data = Buffer.from(await resp.arrayBuffer()).toString('base64');
  const bloco = mediaType === 'application/pdf'
    ? { type: 'document', source: { type: 'base64', media_type: mediaType, data } }
    : { type: 'image', source: { type: 'base64', media_type: mediaType, data } };

  let v;
  try {
    v = await createStructuredMessage({
      messages: [{
        role: 'user',
        content: [
          bloco,
          {
            type: 'text',
            text: 'Esta é a Certidão de Inteiro Teor de uma empresa, emitida pela Junta Comercial. '
              + 'Extraia SOMENTE dados da empresa (nunca dados de sócios): razão social (nome empresarial), '
              + 'nome fantasia (se houver), data de início das atividades/constituição no formato AAAA-MM-DD, '
              + 'e o endereço da sede — logradouro (sem o número), número, complemento, bairro, cidade, '
              + 'UF (2 letras) e CEP. Se a certidão registrar alterações (mudança de endereço ou de nome), '
              + 'use os dados mais recentes. Se um campo não constar com certeza, retorne null — nunca invente.',
          },
        ],
      }],
      schema: certidaoSchema,
    });
  } catch (e) {
    console.error('extrair-certidao IA', e.message);
    return { status: 502, body: { error: 'falha_ia', detalhe: e.message } };
  }

  const data_ = textoOuNull(v?.dataAbertura);
  const cep = String(v?.cep ?? '').replace(/\D/g, '');
  const uf = String(v?.uf ?? '').trim().toUpperCase();
  return {
    status: 200,
    body: {
      campos: {
        razaoSocial: textoOuNull(v?.razaoSocial),
        nomeFantasia: textoOuNull(v?.nomeFantasia),
        dataAbertura: data_ && /^\d{4}-\d{2}-\d{2}$/.test(data_) ? data_ : null,
        cep: cep.length === 8 ? `${cep.slice(0, 5)}-${cep.slice(5)}` : null,
        logradouro: textoOuNull(v?.logradouro),
        numero: textoOuNull(v?.numero),
        complemento: textoOuNull(v?.complemento),
        bairro: textoOuNull(v?.bairro),
        cidade: textoOuNull(v?.cidade),
        uf: /^[A-Z]{2}$/.test(uf) ? uf : null,
      },
      documento: { nome: documento.nome, criadoEm: documento.criadoEm || null },
    },
  };
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

  return Promise.all(snap.docs.map(async (d) => {
    const p = d.data();
    const docsSnap = await d.ref.collection('documentos').get();
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
      concluidoEm: p.concluidoEm || null,
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
      documentos: docsSnap.docs
        .map((x) => x.data())
        .map((x) => ({
          nome: x.nome || '',
          url: x.url || '',
          tipo: x.tipo || '',
          tamanho: x.tamanho || '',
          etapa: x.etapa || '',
          criadoEm: x.criadoEm || null,
        }))
        .sort((a, b) => String(a.criadoEm).localeCompare(String(b.criadoEm))),
    };
  }));
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

  if (req.method === 'POST' && action === 'extrair-certidao') {
    const { processoId, contabilidadeId } = req.body || {};
    if (!processoId || !contabilidadeId) return res.status(400).json({ error: 'parametros_invalidos' });
    const r = await extrairCertidao(db, processoId, contabilidadeId);
    return res.status(r.status).json(r.body);
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
