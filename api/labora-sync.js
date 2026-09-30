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
//   processos              — processos de abertura de empresa já
//                            concluídos (CNPJ ativo) de uma contabilidade,
//                            ainda não importados POR ESSE CONSUMIDOR.
//                            Requer ?contabilidadeId=. Aceita
//                            ?consumidor=ordinatio (padrão: sistema-contabil).
//   marcar-importado (POST) — marca um processo como já importado POR ESSE
//                            CONSUMIDOR (campo próprio — Sistema Contábil
//                            e Ordinatio importam de forma independente,
//                            um não esconde o processo do outro). Aceita
//                            {processoId, consumidor}.
import { getFirebaseAdmin } from './_lib/firebase-admin.js';

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

async function listarProcessosConcluidos(db, contabilidadeId, campoImportado) {
  const snap = await db.collection('processos')
    .where('contabilidadeId', '==', contabilidadeId)
    .where('fluxoKey', '==', 'abertura')
    .where('etapa', '==', 'Concluído')
    .get();

  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .filter((p) => !p[campoImportado])
    .map((p) => ({
      id: p.id,
      empresa: p.empresa || '',
      cnpj: p.cnpj || '',
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

  if (req.method === 'GET' && action === 'processos') {
    const contabilidadeId = req.query?.contabilidadeId;
    if (!contabilidadeId) return res.status(400).json({ error: 'contabilidadeId_obrigatorio' });
    const campoImportado = CAMPO_IMPORTADO[consumidorDe(req)];
    const processos = await listarProcessosConcluidos(db, contabilidadeId, campoImportado);
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
