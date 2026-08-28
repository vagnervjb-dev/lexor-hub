// Busca o certificado digital A1 usado como procurador nas consultas da
// Infosimples (Situação Fiscal, REDESIM/SP). Fica gravado no Firestore em
// configuracoes/infosimplesCertificado — as regras bloqueiam leitura por
// qualquer cliente, mesmo admin; só o Admin SDK (backend) consegue ler.
// Enviado via LexorHub → Configurações.
export async function obterCertificadoInfosimples(db) {
  const snap = await db.collection('configuracoes').doc('infosimplesCertificado').get();
  if (!snap.exists) {
    throw new Error('Certificado digital não configurado — envie em Configurações no LexorHub.');
  }
  const { certificadoBase64, senha } = snap.data();
  if (!certificadoBase64 || !senha) {
    throw new Error('Certificado digital incompleto — reenvie em Configurações no LexorHub.');
  }
  return { certificadoBase64, senha };
}
