// Levanta débitos e situação fiscal de uma empresa (etapa "Levantamento de
// débitos" do fluxo de Encerramento), via Infosimples: PGFN (CND Federal),
// Simples Nacional (sem credencial extra) e Situação Fiscal (via procurador —
// usa o mesmo certificado digital A1 já configurado pro REDESIM/SP).
// Disparado manualmente por processo (cada chamada é paga na Infosimples).
// Requer INFOSIMPLES_TOKEN e INFOSIMPLES_ENCRYPTION_KEY nas env vars; o
// certificado digital em si vem do Firestore (ver _lib/certificado-infosimples.js).
import admin from 'firebase-admin';
import { obterCertificadoInfosimples } from './_lib/certificado-infosimples.js';
import { getEncrypt } from './_lib/aes-bridge-encrypt.js';

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    }),
  });
}
const db = admin.firestore();

function toBase64Url(b64) {
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function consultarPgfn(cnpj) {
  const body = new URLSearchParams({
    token: process.env.INFOSIMPLES_TOKEN,
    cnpj,
    preferencia_emissao: '2via',
    timeout: '300',
  });
  const resp = await fetch('https://api.infosimples.com/api/v2/consultas/receita-federal/pgfn', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const json = await resp.json();
  if (json.code !== 200) throw new Error(`Infosimples PGFN ${json.code}: ${json.code_message}`);
  const d = json.data?.[0] || {};
  return {
    debitosPgfn: !!d.debitos_pgfn,
    debitosRfb: !!d.debitos_rfb,
    certidao: d.certidao || null,
    tipo: d.tipo || null,
    situacao: d.situacao || null,
    validade: d.validade || null,
  };
}

async function consultarSimplesNacional(cnpj) {
  const body = new URLSearchParams({ token: process.env.INFOSIMPLES_TOKEN, cnpj, timeout: '300' });
  const resp = await fetch('https://api.infosimples.com/api/v2/consultas/receita-federal/simples', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const json = await resp.json();
  if (json.code !== 200) throw new Error(`Infosimples Simples Nacional ${json.code}: ${json.code_message}`);
  const d = json.data?.[0] || {};
  return {
    situacao: d.simples_nacional_situacao || null,
    simeiSituacao: d.simei_situacao || null,
  };
}

async function consultarSituacaoFiscal(cnpj) {
  const certificado = await obterCertificadoInfosimples(db);
  const encrypt = await getEncrypt();
  const key = process.env.INFOSIMPLES_ENCRYPTION_KEY;
  const [pkcs12_cert, pkcs12_pass] = await Promise.all([
    encrypt(certificado.certificadoBase64, key).then(toBase64Url),
    encrypt(certificado.senha, key).then(toBase64Url),
  ]);
  const body = new URLSearchParams({
    token: process.env.INFOSIMPLES_TOKEN,
    perfil_procurador_cnpj: cnpj,
    pkcs12_cert,
    pkcs12_pass,
    timeout: '600',
  });
  const resp = await fetch('https://api.infosimples.com/api/v2/consultas/receita-federal/situacao', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const json = await resp.json();
  if (json.code !== 200) throw new Error(`Infosimples Situação Fiscal ${json.code}: ${json.code_message}`);
  const d = json.data?.[0] || {};
  return {
    pendenciasReceitaFederal: d.pendencias_receita_federal || [],
    pendenciasProcuradoria: d.pendencias_procuradoria_geral || [],
    certidaoEmitida: d.certidao_emitida || null,
    sociosEAdministradores: d.socios_e_administradores || [],
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  const authHeader = req.headers.authorization || '';
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!idToken) return res.status(401).json({ error: 'sem_token' });
  try {
    await admin.auth().verifyIdToken(idToken);
  } catch {
    return res.status(401).json({ error: 'token_invalido' });
  }

  const { processoId } = req.body || {};
  if (!processoId) return res.status(400).json({ error: 'parametros_invalidos' });

  const processoRef = db.collection('processos').doc(processoId);
  const processoSnap = await processoRef.get();
  if (!processoSnap.exists) return res.status(404).json({ error: 'processo_nao_encontrado' });

  const cnpj = (processoSnap.data().cnpj || '').replace(/\D/g, '');
  if (!cnpj) return res.status(400).json({ error: 'processo_sem_cnpj' });

  const resultado = { cnpj, verificadoEm: new Date().toISOString() };

  const [pgfn, simplesNacional, situacaoFiscal] = await Promise.allSettled([
    consultarPgfn(cnpj),
    consultarSimplesNacional(cnpj),
    consultarSituacaoFiscal(cnpj),
  ]);

  if (pgfn.status === 'fulfilled') resultado.pgfn = pgfn.value;
  else resultado.erroPgfn = pgfn.reason.message;

  if (simplesNacional.status === 'fulfilled') resultado.simplesNacional = simplesNacional.value;
  else resultado.erroSimplesNacional = simplesNacional.reason.message;

  if (situacaoFiscal.status === 'fulfilled') resultado.situacaoFiscal = situacaoFiscal.value;
  else resultado.erroSituacaoFiscal = situacaoFiscal.reason.message;

  if (!resultado.pgfn && !resultado.simplesNacional && !resultado.situacaoFiscal) {
    return res.status(502).json({ error: 'todas_consultas_falharam', detalhe: resultado });
  }

  const historico = processoSnap.data().historico || [];
  historico.push({
    tipo: 'debitos_verificados',
    etapa: processoSnap.data().etapa || '—',
    obs: 'Débitos e situação fiscal verificados via Infosimples (PGFN/Simples Nacional/Situação Fiscal)',
    data: new Date().toISOString(),
  });
  await processoRef.update({ debitosVerificados: resultado, historico });

  return res.status(200).json({ resultado });
}
