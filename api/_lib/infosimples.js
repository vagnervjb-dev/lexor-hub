// Consultas Infosimples compartilhadas pela geração de proposta (cada consulta é paga).
async function chamar(servico, params, timeout = '240') {
  const body = new URLSearchParams({ token: process.env.INFOSIMPLES_TOKEN, timeout, ...params });
  const resp = await fetch('https://api.infosimples.com/api/v2/consultas/' + servico, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
  });
  const json = await resp.json();
  if (json.code !== 200) throw new Error(`${json.code}: ${json.code_message}`);
  return json.data?.[0] || {};
}
export const consultaCnpj = (cnpj) => chamar('receita-federal/cnpj', { cnpj }, '60');
export const pgfn = async (cnpj) => {
  const d = await chamar('receita-federal/pgfn', { cnpj, preferencia_emissao: '2via' });
  return { debitosPgfn: !!d.debitos_pgfn, debitosRfb: !!d.debitos_rfb, situacao: d.situacao || null, tipo: d.tipo || null, validade: d.validade || null };
};
export const simples = async (cnpj) => {
  const d = await chamar('receita-federal/simples', { cnpj });
  return { situacao: d.simples_nacional_situacao || null, simei: d.simei_situacao || null };
};
export const fgts = async (cnpj) => {
  const d = await chamar('caixa/regularidade', { cnpj, preferencia_emissao: '2via' });
  return { situacao: d.situacao || null, validadeInicio: d.validade_inicio_data || null, validadeFim: d.validade_fim_data || null };
};
export async function debitos(cnpj) {
  const nomes = ['pgfn', 'simples', 'fgts'];
  const fn = { pgfn, simples, fgts };
  const rs = await Promise.allSettled(nomes.map((n) => fn[n](cnpj)));
  const out = {};
  nomes.forEach((n, i) => {
    const r = rs[i];
    out[n] = r.status === 'fulfilled' ? { ok: true, ...r.value }
      : { ok: false, erro: String(r.reason?.message || r.reason), instavel: /\b6\d\d:/.test(String(r.reason?.message || '')) };
  });
  return out;
}
