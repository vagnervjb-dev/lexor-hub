// Cron diário (ver vercel.json) — consulta o status do protocolo REDESIM na
// JUCESP via Infosimples para todo processo com uf="SP" e numeroProtocolo
// preenchido, e grava o resultado em statusRedesim/historicoRedesim.
//
// Cobertura: só SP. A Infosimples não tem produto equivalente para outros
// estados (verificado em 2026-08) — processos de outras UFs continuam usando
// o botão "Consultar no REDESIM" manual já existente no painel do processo.
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

const INFOSIMPLES_URL = 'https://api.infosimples.com/api/v2/consultas/junta-comercial/sp/redesim/acp';

function toBase64Url(b64) {
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function consultarProtocoloSP(numeroProtocolo, certificado) {
  const encrypt = await getEncrypt();
  const key = process.env.INFOSIMPLES_ENCRYPTION_KEY;
  const [pkcs12_cert, pkcs12_pass] = await Promise.all([
    encrypt(certificado.certificadoBase64, key).then(toBase64Url),
    encrypt(certificado.senha, key).then(toBase64Url),
  ]);

  const body = new URLSearchParams({
    token: process.env.INFOSIMPLES_TOKEN,
    protocolo: numeroProtocolo,
    pkcs12_cert,
    pkcs12_pass,
    timeout: '600',
  });

  const resp = await fetch(INFOSIMPLES_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const json = await resp.json();

  if (json.code !== 200) {
    throw new Error(`Infosimples ${json.code}: ${json.code_message}`);
  }
  const lista = json.data?.[0]?.primeiro_protocolo_lista;
  const dados = lista?.dados_protocolo;
  if (!dados) throw new Error('Resposta da Infosimples sem dados_protocolo.');

  // A mesma resposta já traz dados da empresa (de graça, é a mesma chamada paga
  // pro status) — aproveita pra pré-preencher o processo, sem precisar de IA
  // nem de documento nenhum, quando esses campos ainda estiverem vazios.
  const estabelecimento = lista?.estabelecimento;
  const atividades = lista?.atividades_economicas || [];
  const cnaePrincipal = atividades.find(a => /principal/i.test(a.cnae || ''))?.cnae || atividades[0]?.cnae || null;

  return {
    status: dados.status,
    datahoraSolicitacao: dados.datahora_solicitacao,
    cnpj: estabelecimento?.cnpj || null,
    naturezaJuridica: estabelecimento?.natureza_juridica || null,
    endereco: lista?.endereco?.confirmado || lista?.endereco?.indicado || null,
    cnae: cnaePrincipal,
  };
}

export default async function handler(req, res) {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  let certificado;
  try {
    certificado = await obterCertificadoInfosimples(db);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  const snap = await db.collection('processos').where('uf', '==', 'SP').get();
  const alvos = snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(p => p.numeroProtocolo && p.status !== 'concluido');

  const resultados = [];
  for (const p of alvos) {
    try {
      const r = await consultarProtocoloSP(p.numeroProtocolo, certificado);
      const agora = new Date().toISOString();
      const updates = {};

      if (r.status && r.status !== p.statusRedesim) {
        updates.statusRedesim = r.status;
        updates.statusRedesimAtualizadoEm = agora;
        updates.historicoRedesim = admin.firestore.FieldValue.arrayUnion({
          data: agora,
          statusAnterior: p.statusRedesim || null,
          statusNovo: r.status,
          datahoraSolicitacaoRedesim: r.datahoraSolicitacao || null,
        });
      }
      // Só preenche o que ainda está vazio — não sobrescreve dado já corrigido
      // manualmente ou extraído por IA a partir dos documentos.
      if (r.cnpj && !p.cnpj) updates.cnpj = r.cnpj;
      if (r.naturezaJuridica && !p.naturezaJuridica) updates.naturezaJuridica = r.naturezaJuridica;
      if (r.endereco && !p.endereco) updates.endereco = r.endereco;
      if (r.cnae && !p.cnae) updates.cnae = r.cnae;

      if (Object.keys(updates).length > 0) {
        await db.collection('processos').doc(p.id).update(updates);
        resultados.push({ id: p.id, status: r.status, atualizado: true, campos: Object.keys(updates) });
      } else {
        resultados.push({ id: p.id, status: r.status, atualizado: false });
      }
    } catch (e) {
      console.error(`Erro ao consultar protocolo do processo ${p.id}:`, e.message);
      resultados.push({ id: p.id, erro: e.message });
    }
  }

  return res.status(200).json({ verificados: alvos.length, resultados });
}
