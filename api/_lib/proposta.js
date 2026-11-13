// Lógica comercial da Labora: normaliza dados do CNPJ, faz o diagnóstico, escreve as mensagens
// e monta a proposta (HTML com capa). Usado por /api/gerar-proposta.
import { LOGO_LABORA } from './logo-labora.js';

export const esc = (t) => String(t == null || t === '' ? '—' : t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function normInfosimples(d) {
  return {
    fonte: 'Receita Federal (Infosimples)', razao_social: d.razao_social, nome_fantasia: d.nome_fantasia, cnpj: d.cnpj,
    situacao: (d.situacao_cadastral || '') + (d.situacao_cadastral_data ? ' (' + d.situacao_cadastral_data + ')' : ''),
    abertura: d.abertura_data, natureza: d.natureza_juridica, porte: d.porte, capital: d.capital_social, matriz: d.matriz_filial,
    telefone: d.telefone, email: d.email,
    endereco: [d.endereco_logradouro, d.endereco_numero, d.endereco_complemento].filter(Boolean).join(', ') + ' — ' +
      [d.endereco_bairro, (d.endereco_municipio || '') + '/' + (d.endereco_uf || ''), d.endereco_cep].filter(Boolean).join(' · '),
    cnae: d.atividade_economica, secundarios: d.atividade_economica_secundaria_lista || [],
    socios: (d.qsa || []).map((q) => ({ nome: q.nome, qual: q.qualificacao })),
  };
}

export function normBrasilApi(d) {
  const fd = (x) => (x ? x.split('-').reverse().join('/') : '');
  return {
    fonte: 'BrasilAPI (reserva)', razao_social: d.razao_social, nome_fantasia: d.nome_fantasia, cnpj: d.cnpj,
    situacao: (d.descricao_situacao_cadastral || '') + (d.data_situacao_cadastral ? ' (' + fd(d.data_situacao_cadastral) + ')' : ''),
    abertura: fd(d.data_inicio_atividade), natureza: d.natureza_juridica, porte: d.porte,
    capital: d.capital_social != null ? Number(d.capital_social).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) : '',
    matriz: '', telefone: d.ddd_telefone_1, email: d.email,
    endereco: [d.descricao_tipo_de_logradouro, d.logradouro, d.numero, d.complemento].filter(Boolean).join(' ') + ' — ' +
      [d.bairro, (d.municipio || '') + '/' + (d.uf || ''), d.cep].filter(Boolean).join(' · '),
    cnae: (d.cnae_fiscal || '') + ' - ' + (d.cnae_fiscal_descricao || ''),
    secundarios: (d.cnaes_secundarios || []).map((c) => c.codigo + ' - ' + c.descricao),
    socios: (d.qsa || []).map((q) => ({ nome: q.nome_socio, qual: q.qualificacao_socio })),
  };
}

const diasAte = (br) => {
  const m = /(\d{2})\/(\d{2})\/(\d{4})/.exec(br || '');
  if (!m) return null;
  const hoje = new Date(new Date().toDateString());
  return Math.round((new Date(+m[3], +m[2] - 1, +m[1]) - hoje) / 86400000);
};
const titulo = (s) => String(s || '').toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase());

// Nome curto para falar da empresa: fantasia, senão razão social sem sufixo societário.
export function nomeCurto(n) {
  const base = n.nome_fantasia || String(n.razao_social || '').replace(/\b(LTDA|EIRELI|S\.?A\.?|ME|EPP|MEI)\b\.?/gi, '').trim();
  return titulo(base) || 'a empresa';
}

// Diagnóstico a partir da ficha (n) e das consultas de débito (deb: {pgfn, simples, fgts}).
export function analisar(n, deb = {}) {
  const sim = deb.simples, p = deb.pgfn, f = deb.fgts;
  const naoSimples = !!(sim && sim.ok && /n[ãa]o\s+optante/i.test(sim.situacao || ''));
  const optSimples = !!(sim && sim.ok && !naoSimples && /optante/i.test(sim.situacao || ''));
  const cndFalhou = !p || !p.ok;
  const cndDebitos = !!(p && p.ok && (p.debitosPgfn || p.debitosRfb));
  const fgtsOk = !!(f && f.ok && /regular/i.test(f.situacao || '') && !/irregular/i.test(f.situacao || ''));
  const fgtsIrreg = !!(f && f.ok && !fgtsOk);
  const fgtsDias = f && f.ok ? diasAte(f.validadeFim) : null;
  const diag = [];
  diag.push({ t: 'Situação cadastral', pill: /ATIV/i.test(n.situacao || '') ? ['ok', 'Ativa'] : ['warn', 'Verificar'], res: n.situacao, nota: 'Dados da Receita Federal.' });
  if (sim) diag.push({
    t: 'Simples Nacional', pill: !sim.ok ? ['idle', 'Sem resultado'] : naoSimples ? ['warn', 'Em análise'] : ['ok', 'Optante'],
    res: sim.ok ? sim.situacao + (sim.simei ? ' · SIMEI: ' + sim.simei : '') : 'Não foi possível consultar',
    nota: !sim.ok ? 'A fonte não respondeu.' : naoSimples ? 'Fora do Simples. A opção é decidida em janeiro, então vale simular o regime agora.' : 'Optante. Vale revisar enquadramento e anexo.',
  });
  if (f) diag.push({
    t: 'FGTS (Caixa)', pill: !f.ok ? ['idle', 'Sem resultado'] : fgtsOk ? ['ok', 'Regular'] : ['warn', 'Irregular'],
    res: f.ok ? f.situacao + (f.validadeFim ? ' · válido até ' + f.validadeFim : '') : 'Não foi possível consultar',
    nota: !f.ok ? 'A fonte não respondeu.' : fgtsIrreg ? 'Situação irregular no FGTS. Precisa de regularização.' : (fgtsDias != null && fgtsDias <= 30 ? `O certificado vence em ${fgtsDias} dias e pode ser renovado.` : 'Regular.'),
  });
  diag.push({
    t: 'CND federal (PGFN e Receita)', pill: cndFalhou ? ['idle', 'Sem resultado'] : cndDebitos ? ['warn', 'Com débitos'] : ['ok', 'Sem débitos'],
    res: cndFalhou ? 'Não foi possível validar' : cndDebitos ? 'Há débitos federais em aberto' : 'Sem débitos federais',
    nota: cndFalhou ? 'A consulta automática não conseguiu validar a certidão. Pedimos que a empresa envie a certidão, emitida no site da Receita, para confirmarmos a situação.'
      : cndDebitos ? 'Débitos identificados na consulta pública. Confirmar valores antes de falar com a empresa.' : 'Certidão emitida sem apontamentos.',
  });
  const op = [];
  if (naoSimples) op.push('Simulação de regime: Simples ou Lucro Presumido');
  else if (optSimples) op.push('Revisão de enquadramento no Simples');
  if (cndDebitos) op.push('Regularização de débitos federais');
  if (cndFalhou) op.push('Validação da CND federal');
  if (fgtsIrreg) op.push('Regularização do FGTS');
  else if (fgtsDias != null && fgtsDias <= 30) op.push('Renovação do certificado de FGTS');
  op.push('Contabilidade completa');
  return { naoSimples, optSimples, cndFalhou, cndDebitos, fgtsOk, fgtsIrreg, fgtsDias, diag, oportunidades: op };
}

const sufixoOptOut = 'Se preferirem não receber mensagens, é só avisar.';

// Etapa 1 — resposta ao primeiro contato (sem anexo). Pede a CND e o decisor.
export function mensagemContato(n, a, { contato = '', decisor = '' } = {}) {
  const emp = nomeCurto(n);
  const par = [`Obrigado${contato ? ', ' + contato : ''}!`];
  if (a.cndFalhou) {
    par.push(`Nossa ferramenta consultou os dados públicos da ${emp} e não conseguiu validar a certidão negativa de débitos federal (CND da Receita e PGFN).`);
    par.push('Gostaríamos de ver a certidão, que a própria empresa emite no site da Receita.');
  } else if (a.cndDebitos) {
    par.push(`Nossa ferramenta consultou os dados públicos da ${emp} e apareceram apontamentos na situação federal da empresa. Podemos conversar sobre como regularizar?`);
  } else {
    par.push(`Nossa ferramenta consultou os dados públicos da ${emp} e a situação federal está em ordem.`);
  }
  if (a.naoSimples) {
    par.push('Aproveitando: pelos dados públicos a empresa não está no Simples Nacional, e a escolha do regime é feita em janeiro.');
    par.push('Fazemos uma simulação comparando os regimes para ver se há economia de impostos. Para isso, precisamos do faturamento dos últimos 12 meses.');
  }
  par.push(decisor ? `Pode nos conectar com ${decisor} ou com quem cuida da contabilidade?` : 'Pode nos conectar com quem cuida da contabilidade da empresa?');
  par.push(sufixoOptOut);
  return par.join('\n\n');
}

// Etapa 2 — envio da proposta ao decisor (com o PDF anexo).
export function mensagemProposta(n, a, { decisor = '' } = {}) {
  const emp = nomeCurto(n);
  const par = [`Olá${decisor ? ', ' + decisor : ''}! Conforme conversamos, segue a proposta da Labora Contabilidade e Gestão para a ${emp}.`];
  par.push(a.naoSimples
    ? 'Ela está em duas etapas: primeiro comparamos os regimes tributários com os números da empresa, e só depois, se fizer sentido, falamos da contabilidade mensal.'
    : 'Ela traz o diagnóstico da empresa e o caminho que sugerimos para a contabilidade.');
  par.push('Qualquer dúvida, é só chamar. Podemos marcar 20 minutos para passar por ela juntos?');
  par.push(sufixoOptOut);
  return par.join('\n\n');
}

const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const dataExtenso = (d) => `${d.getDate()} de ${MESES[d.getMonth()]} de ${d.getFullYear()}`;

const CSS = `
@page{size:A4;margin:0}
:root{--bg:#fff;--soft:#F8F5EE;--soft2:#F3EDE0;--bd:#E6DCC6;--ink:#1B2547;--gold:#8B6914;--grey:#5C6275;--muted:#555B6E;
--ok:#1D7A4B;--ok-bg:#E1F3E9;--warn:#9A5A06;--warn-bg:#FDF0D8;--idle:#58677A;--idle-bg:#E8EEF5;
--f:'Inter',-apple-system,'Segoe UI',Arial,sans-serif;--s:'Liberation Serif','Times New Roman',Georgia,serif}
*{box-sizing:border-box}html,body{-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{margin:0;background:#fff;color:var(--ink);font-family:var(--f);font-size:13px;line-height:1.5}
h1,h2,h3,p,ul,ol,dl,dd{margin:0}
.cover{height:297mm;display:flex;flex-direction:column;align-items:center;font-family:var(--s);break-after:page;position:relative}
.cover img{margin-top:46mm;width:78mm}
.cover h1{margin-top:62mm;font-size:34px;font-weight:700}
.cover .s{margin-top:8px;font-size:19px;color:var(--gold)}.cover .p{margin-top:6px;font-size:17px;color:#555}
.cover .f{position:absolute;bottom:42mm;text-align:center;font-size:15px}.cover .f b{display:block;font-weight:400;color:var(--gold)}.cover .f span{color:#888}
.wrap{padding:0 14mm}
.top{display:flex;justify-content:space-between;padding-block:12px;border-bottom:2px solid var(--gold);font-size:12px;color:var(--grey)}
.top b{color:var(--ink);display:flex;align-items:center;gap:9px}.top b img{height:28px}
.eyebrow{font-size:11px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--gold)}
.hero{padding-top:24px}.hero h1{font-family:var(--s);font-size:36px;line-height:1.1;margin-top:12px}
.hero h1 em{display:block;font-style:normal;color:var(--gold)}.hero .sub{color:var(--muted);font-size:14.5px;margin-top:12px;max-width:58ch}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin-top:16px}
.chip{display:inline-flex;align-items:center;gap:7px;border:1px solid var(--bd);background:var(--soft);border-radius:999px;padding:5px 12px;font-size:12px}
.chip i{width:8px;height:8px;border-radius:50%;background:var(--idle)}.chip.ok i{background:var(--ok)}.chip.warn i{background:#E39A20}
.tiles{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-top:18px}
.tile{background:var(--soft);border-radius:14px;padding:11px 14px;break-inside:avoid}
.tile b{display:block;font-family:var(--s);font-size:20px;color:var(--gold)}.tile span{display:block;font-size:12px;color:var(--grey)}
main{padding-block:22px 8px;display:grid;gap:24px}
.tag{font-size:11px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--gold)}
.sec-head{margin-bottom:10px;break-after:avoid}.sec-head h2{font-family:var(--s);font-size:22px;margin-top:2px}.sec-head p{color:var(--muted);margin-top:4px}
.lead{background:var(--soft2);border-left:4px solid var(--gold);border-radius:16px;padding:15px 18px;font-family:var(--s);font-size:14.5px;line-height:1.55;break-inside:avoid}
.cards{display:grid;grid-template-columns:1fr 1fr;gap:9px}.card{background:var(--soft);border-radius:16px;padding:13px 16px;break-inside:avoid}
.card h3{font-family:var(--s);font-size:16px}.row{display:flex;justify-content:space-between;gap:8px;align-items:center}
.pill{font-size:11px;font-weight:700;border-radius:999px;padding:3px 10px;white-space:nowrap}
.pill.ok{background:var(--ok-bg);color:var(--ok)}.pill.warn{background:var(--warn-bg);color:var(--warn)}.pill.idle{background:var(--idle-bg);color:var(--idle)}
.res{font-weight:700;margin-top:8px}.note{color:var(--muted);margin-top:4px;font-size:12.5px}
.stage{font-size:11px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--gold)}
.card ul{padding-left:18px;margin-top:6px}.card li{margin-bottom:3px}
.badge{font-size:11px;font-weight:700;border-radius:8px;padding:3px 9px;background:#fff;color:var(--gold);border:1px solid var(--bd)}
.facts{display:grid;grid-template-columns:1fr 1fr;gap:8px}.fact{background:var(--soft);border-radius:14px;padding:9px 14px;break-inside:avoid}
.fact.full{grid-column:1/-1}.fact dt{font-size:11px;font-weight:600;color:var(--grey)}.fact dd{font-weight:600}
.cnae{margin-top:6px}.cnae span{display:inline-block;background:#fff;border:1px solid var(--bd);border-radius:8px;padding:2px 9px;margin:3px 4px 0 0;font-size:11.5px;color:var(--muted)}
.tbl-wrap{border:1px solid var(--bd);border-radius:16px;overflow:hidden}.tbl{width:100%;border-collapse:collapse}
.tbl th{font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--grey);background:var(--soft);text-align:left;padding:10px 18px}
.tbl td{padding:11px 18px;border-top:1px solid var(--bd);vertical-align:top;font-weight:600}.tbl td small{display:block;font-weight:400;color:var(--muted);font-size:12px}
.tbd{display:inline-block;border:1.5px dashed var(--gold);color:var(--gold);border-radius:8px;padding:2px 11px;font-weight:700;font-size:12px;white-space:nowrap}
.valor{font-weight:700;color:var(--ink)}.valid{margin-top:12px;color:var(--muted)}
.steps{list-style:none;padding:0;display:grid;gap:12px}.steps li{display:flex;gap:14px;break-inside:avoid}
.steps .n{width:36px;height:36px;border-radius:50%;background:var(--gold);color:#fff;display:grid;place-items:center;font-weight:800;flex:none}
.steps b{font-family:var(--s);font-size:15px;display:block}.steps span{color:var(--muted)}
footer{border-top:1px solid var(--bd);padding:10px 14mm 6px;color:var(--grey);font-size:11px}
main>section:nth-of-type(3),main>section:nth-of-type(5){break-before:page;padding-top:24px}
`;

// Monta a proposta completa (capa + miolo). opcoes: {decisor, valores:{etapa1, etapa2, complementares, validade}, numero}
export function propostaHtml(n, a, { decisor = '', valores = {}, numero = '' } = {}) {
  const emp = nomeCurto(n);
  const hoje = new Date();
  const data = hoje.toLocaleDateString('pt-BR');
  const v = (x) => (x ? `<span class="valor">${esc(x)}</span>` : '<span class="tbd">A definir</span>');
  const mAb = /(\d{2})\/(\d{2})\/(\d{4})/.exec(n.abertura || '');
  const anos = mAb ? Math.max(0, hoje.getFullYear() - +mAb[3] - (hoje < new Date(+mAb[3] + (hoje.getFullYear() - +mAb[3]), +mAb[2] - 1, +mAb[1]) ? 1 : 0)) : null;
  const socios = n.socios || [];
  const sub = a.naoSimples
    ? 'Começamos descobrindo, com os números da empresa, qual regime tributário faz mais sentido para o próximo ano.'
    : 'Começamos entendendo a situação fiscal da empresa e o que podemos organizar na rotina contábil.';
  const chips = [
    [/ATIV/i.test(n.situacao || '') ? 'ok' : 'warn', 'Situação ' + String(n.situacao || '').split(' (')[0]],
    a.naoSimples ? ['warn', 'Fora do Simples Nacional'] : a.optSimples ? ['ok', 'Optante pelo Simples'] : null,
    a.fgtsOk ? ['ok', 'FGTS regular' + (a.fgtsDias != null ? ` · vence em ${a.fgtsDias} dias` : '')] : a.fgtsIrreg ? ['warn', 'FGTS irregular'] : null,
    a.cndFalhou ? ['', 'CND federal sem resposta'] : a.cndDebitos ? ['warn', 'CND federal com débitos'] : ['ok', 'CND federal sem débitos'],
  ].filter(Boolean);
  const lead = `Pelos dados públicos da Receita Federal, ${emp} é uma empresa ${esc(n.porte || '')} ${/ATIV/i.test(n.situacao || '') ? 'ativa' : ''}${mAb ? ' desde ' + mAb[3] : ''}${a.naoSimples ? ' e hoje não está no Simples Nacional' : ''}. ` +
    (a.cndFalhou ? 'A consulta automática da certidão federal não retornou. Propomos esclarecer a certidão e, ' : 'Propomos ') +
    (a.naoSimples ? 'comparar os regimes com os números reais da empresa antes de janeiro, quando a opção pelo Simples é decidida.' : 'revisar o enquadramento e organizar a rotina contábil.');
  const fatos = [['CNPJ', n.cnpj + (n.matriz ? ` (${String(n.matriz).toLowerCase()})` : '')], ['Natureza jurídica', n.natureza], ['Situação cadastral', n.situacao], ['Contato', [n.telefone, n.email].filter(Boolean).join(' · ')]];
  const ini = `${esc(emp)}`;
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Proposta ${ini}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap"><style>${CSS}</style></head><body>
<section class="cover"><img src="${LOGO_LABORA}" alt="Labora"><h1>PROPOSTA COMERCIAL</h1>
<div class="s">${a.naoSimples ? 'Análise Tributária + Contabilidade Completa' : 'Diagnóstico Fiscal + Contabilidade Completa'}</div>
<div class="p">Preparado para ${ini}</div>
<div class="f"><b>${numero ? 'Proposta nº ' + esc(numero) : 'Labora Contabilidade e Gestão'}</b><span>${dataExtenso(hoje)}</span></div></section>
<div class="wrap"><div class="top"><b><img src="${LOGO_LABORA}" alt="">Labora Contabilidade e Gestão</b><span>Proposta comercial · ${data}</span></div>
<div class="hero"><span class="eyebrow">Preparada para ${esc(decisor || nomeCurto(n))}</span>
<h1>${a.naoSimples ? 'Análise tributária e contabilidade' : 'Diagnóstico fiscal e contabilidade'} <em>para ${ini}.</em></h1><p class="sub">${sub}</p>
<div class="chips">${chips.map((c) => `<span class="chip ${c[0]}"><i></i>${esc(c[1])}</span>`).join('')}</div>
<div class="tiles">${[
    anos != null ? [`${anos} ${anos === 1 ? 'ano' : 'anos'}`, 'aberta em ' + n.abertura] : null,
    n.capital ? [String(n.capital).replace(/,00$/, ''), 'capital social'] : null,
    n.porte ? [n.porte, 'porte'] : null,
    [`${socios.length} ${socios.length === 1 ? 'sócio' : 'sócios'}`, socios[0] ? titulo(socios[0].nome) : '—'],
  ].filter(Boolean).map((t) => `<div class="tile"><b>${esc(t[0])}</b><span>${esc(t[1])}</span></div>`).join('')}</div></div>
<main>
<section><div class="sec-head"><div class="tag">Entendimento</div><h2>O que observamos</h2></div><p class="lead">${lead}</p></section>
<section><div class="sec-head"><div class="tag">O que os dados mostram</div><h2>Diagnóstico</h2><p>Pontos que merecem atenção antes de definir o regime e a rotina contábil.</p></div>
<div class="cards">${a.diag.map((d) => `<article class="card"><div class="row"><h3>${esc(d.t)}</h3><span class="pill ${d.pill[0]}">${esc(d.pill[1])}</span></div><p class="res">${esc(d.res)}</p><p class="note">${esc(d.nota)}</p></article>`).join('')}</div></section>
<section><div class="sec-head"><div class="tag">Receita Federal</div><h2>Ficha da empresa</h2><p>Dados públicos da Receita Federal, consultados em ${data}.</p></div>
<dl class="facts"><div class="fact full"><dt>Razão social</dt><dd>${esc(n.razao_social)}</dd></div>
${fatos.map((f) => `<div class="fact"><dt>${f[0]}</dt><dd>${esc(f[1])}</dd></div>`).join('')}
<div class="fact full"><dt>Endereço</dt><dd>${esc(n.endereco)}</dd></div>
<div class="fact full"><dt>CNAE principal</dt><dd>${esc(n.cnae)}</dd><div class="cnae">${(n.secundarios || []).map((c) => `<span>${esc(c)}</span>`).join('')}</div></div>
<div class="fact full"><dt>Quadro societário</dt>${socios.map((q) => `<dd>${esc(titulo(q.nome))} · ${esc(q.qual)}</dd>`).join('') || '<dd>—</dd>'}</div></dl></section>
<section><div class="sec-head"><div class="tag">Escopo</div><h2>Proposta em duas etapas</h2><p>A segunda etapa só acontece se a primeira fizer sentido para vocês.</p></div>
<div class="cards"><article class="card"><div class="stage">Etapa 1</div><h3>${a.naoSimples ? 'Análise tributária' : 'Diagnóstico fiscal'}</h3><ul>
<li>${a.naoSimples ? 'Simulação comparando Simples Nacional e Lucro Presumido com o faturamento dos últimos 12 meses' : 'Revisão do enquadramento e das obrigações da empresa'}</li>
<li>Diferença de imposto em reais por ano, em cada regime</li><li>Recomendação por escrito</li><li>Reunião para apresentar o resultado</li></ul></article>
<article class="card"><div class="stage">Etapa 2</div><h3>Contabilidade mensal</h3><ul><li>Escrituração contábil e fiscal</li><li>Apuração e guias de impostos</li><li>Folha de pagamento e pró-labore</li><li>Obrigações acessórias e certidões</li><li>Atendimento direto com a equipe</li></ul>
<p class="note">${a.naoSimples ? 'Início previsto para janeiro do próximo ano.' : 'Início combinado com a empresa.'}</p></article></div></section>
<section><div class="sec-head"><div class="tag">Opcionais</div><h2>Serviços complementares</h2><p>Contratados somente se fizerem sentido, sem vínculo com as etapas acima.</p></div>
<div class="cards">${[
    ['Revisão de CNAEs', 'Atualizar o contrato social para que as atividades registradas reflitam o que a empresa faz hoje.'],
    ['Certidões e regularidade', 'Renovação das certidões e acompanhamento mensal da situação fiscal, trabalhista e do FGTS.'],
    ['Registro de marca', `Consulta de disponibilidade e registro da marca ${emp} no INPI.`],
    ['Certificado digital e-CNPJ', 'Emissão ou renovação do certificado digital da empresa.'],
  ].map((s) => `<article class="card"><div class="row"><h3>${s[0]}</h3><span class="badge">Labora</span></div><p class="note">${s[1]}</p></article>`).join('')}</div></section>
<section><div class="sec-head"><div class="tag">Valores</div><h2>Investimento</h2></div><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Item</th><th>Cobrança</th><th>Valor</th></tr></thead><tbody>
<tr><td>Etapa 1 · ${a.naoSimples ? 'Análise tributária' : 'Diagnóstico fiscal'}<small>Simulação, recomendação e reunião de apresentação</small></td><td>Pontual</td><td>${v(valores.etapa1)}</td></tr>
<tr><td>Etapa 2 · Contabilidade mensal<small>Escopo completo descrito acima</small></td><td>Mensal</td><td>${v(valores.etapa2)}</td></tr>
<tr><td>Serviços complementares<small>Cada item é orçado separadamente</small></td><td>Sob consulta</td><td>${v(valores.complementares || 'Sob consulta')}</td></tr></tbody></table></div>
<p class="valid">Validade da proposta: ${v(valores.validade)}</p></section>
<section><div class="sec-head"><div class="tag">Como seguimos</div><h2>Próximos passos</h2></div><ol class="steps">
<li><span class="n">1</span><div><b>Conversa de 20 minutos</b><span>Entendemos como a empresa está hoje e qual regime ela usa.</span></div></li>
<li><span class="n">2</span><div><b>Envio de documentos</b><span>Faturamento mensal dos últimos 12 meses${a.cndFalhou ? ' e a certidão negativa de débitos federal (CND da Receita e PGFN), que a própria empresa emite no site da Receita' : ''}.</span></div></li>
<li><span class="n">3</span><div><b>Apresentação do resultado</b><span>Mostramos a diferença em reais por ano e decidimos juntos o que fazer.</span></div></li></ol></section>
</main></div>
<footer>Labora Contabilidade e Gestão · Proposta preparada em ${data} com base em dados públicos da Receita Federal. As conclusões tributárias dependem dos números reais da empresa.</footer>
</body></html>`;
}
