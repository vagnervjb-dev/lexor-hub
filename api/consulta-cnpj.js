// Consulta completa de CNPJ (Receita Federal) via Infosimples.
// Botão "Consultar CNPJ" do Lexor Hub. Requer INFOSIMPLES_TOKEN (já usado pelas
// outras funções). Só usuários logados no Firebase podem chamar (cada consulta é paga).
import { getFirebaseAdmin } from './_lib/firebase-admin.js';

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

  try {
    const body = new URLSearchParams({ token: process.env.INFOSIMPLES_TOKEN, cnpj, timeout: '60' });
    const resp = await fetch('https://api.infosimples.com/api/v2/consultas/receita-federal/cnpj', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const json = await resp.json();
    if (json.code !== 200) {
      return res.status(json.code === 612 ? 404 : 502).json({ error: 'infosimples_' + json.code, detalhe: json.code_message });
    }
    return res.status(200).json({ data: json.data?.[0] || null });
  } catch (e) {
    return res.status(502).json({ error: 'falha_consulta', detalhe: e.message });
  }
}
