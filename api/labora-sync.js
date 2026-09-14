// Integração servidor-a-servidor com o Sistema Contábil LABORA (app
// desktop, roda local na máquina do usuário — não tem como a LexorHub
// chamar ele de volta, então é sempre o Sistema Contábil que busca aqui).
//
// Autenticação própria (chave estática em header), diferente do token
// Firebase usado pelas outras rotas: quem chama não é um usuário logado
// no navegador, é outro backend. Ver LABORA_SYNC_API_KEY nas env vars.
//
// Ações (query string ?action=):
//   contabilidades        — lista Usuarios com role=contabilidade (pro
//                            Sistema Contábil deixar o usuário escolher
//                            qual é a LABORA, sem precisar decorar um id).
//   processos              — processos de abertura de empresa já
//                            concluídos (CNPJ ativo) de uma contabilidade,
//                            ainda não importados. Requer ?contabilidadeId=.
//   marcar-importado (POST) — marca um processo como já importado, pra
//                            não aparecer de novo na próxima busca.
import { getFirebaseAdmin } from './_lib/firebase-admin.js';

function autenticado(req) {
  const chave = req.headers['x-api-key'];
  return !!process.env.LABORA_SYNC_API_KEY && chave === process.env.LABORA_SYNC_API_KEY;
}

async function listarContabilidades(db) {
  const snap = await db.collection('Usuarios').get();
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .filter((u) => u.role === 'contabilidade')
    .map((u) => ({ id: u.id, nome: u.nome || u.email || u.id }));
}

async function listarProcessosConcluidos(db, contabilidadeId) {
  const snap = await db.collection('processos')
    .where('contabilidadeId', '==', contabilidadeId)
    .where('fluxoKey', '==', 'abertura')
    .where('etapa', '==', 'Concluído')
    .get();

  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .filter((p) => !p.importadoLabora)
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
    const processos = await listarProcessosConcluidos(db, contabilidadeId);
    return res.status(200).json({ processos });
  }

  if (req.method === 'POST' && action === 'marcar-importado') {
    const { processoId } = req.body || {};
    if (!processoId) return res.status(400).json({ error: 'processoId_obrigatorio' });
    const ref = db.collection('processos').doc(processoId);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: 'processo_nao_encontrado' });
    await ref.update({ importadoLabora: true, importadoLaboraEm: new Date().toISOString() });
    return res.status(200).json({ ok: true });
  }

  return res.status(400).json({ error: 'acao_invalida' });
}
