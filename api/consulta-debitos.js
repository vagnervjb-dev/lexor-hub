// Verificação rápida de débitos/regularidade de qualquer CNPJ (botão avulso do Lexor Hub).
// Consulta em paralelo na Infosimples: PGFN (CND federal), Simples Nacional e FGTS (Caixa).
// Cada consulta é paga; só usuários logados podem chamar. Usa INFOSIMPLES_TOKEN.
import { getFirebaseAdmin } from './_lib/firebase-admin.js';

async function chamar(servico, params) {
  const body = new URLSearchParams({ token: process.env.INFOSIMPLES_TOKEN, timeout: '240', ...params });
  const resp = await fetch('https://api.infosimples.com/api/v2/consultas/' + servico, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const json = await resp.json();
  if (json.code !== 200) throw new Error(`${json.code}: ${json.code_message}`);
  return json.data?.[0] || {};
}

const pgfn = async (cnpj) => {
  const d = await chamar('receita-federal/pgfn', { cnpj, preferencia_emissao: '2via' });
  return {
    debitosPgfn: !!d.debitos_pgfn, debitosRfb: !!d.debitos_rfb,
    situacao: d.situacao || null, tipo: d.tipo || null, validade: d.validade || null,
    certidao: d.certidao || null,
  };
};
const simples = async (cnpj) => {
  const d = await chamar('receita-federal/simples', { cnpj });
  return { situacao: d.simples_nacional_situacao || null, simei: d.simei_situacao || null };
};
const fgts = async (cnpj) => {
  const d = await chamar('caixa/regularidade', { cnpj, preferencia_emissao: '2via' });
  return {
    situacao: d.situacao || null, validadeInicio: d.validade_inicio_data || null,
    validadeFim: d.validade_fim_data || null, crf: d.crf || null,
  };
};

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  const authHeader = req.headers.authorization || '';
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!idToken) return res.status(401).json({ error: 'sem_token' });
  try {
    const { auth } = await getFirebaseAdmin();
    await auth.verifyIdToken(idToken);
  } catch (e) {
    return res.status(401).json({ error: 'token_invalido', detalhe: e.code || e.message });
  }

  const cnpj = String(req.body?.cnpj || '').replace(/\D/g, '');
  if (cnpj.length !== 14) return res.status(400).json({ error: 'cnpj_invalido' });
  if (!process.env.INFOSIMPLES_TOKEN) return res.status(500).json({ error: 'INFOSIMPLES_TOKEN_ausente' });

  const [a, b, c] = await Promise.allSettled([pgfn(cnpj), simples(cnpj), fgts(cnpj)]);
  const pack = (r) => r.status === 'fulfilled' ? { ok: true, ...r.value } : { ok: false, erro: String(r.reason?.message || r.reason) };
  return res.status(200).json({ pgfn: pack(a), simples: pack(b), fgts: pack(c) });
}
