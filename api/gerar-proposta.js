// Gera, a partir de um CNPJ, o material comercial da Labora.
//   etapa "contato":  consulta Receita + débitos e devolve diagnóstico + mensagem (sem anexo) para responder o 1º contato.
//   etapa "proposta": devolve também a proposta em PDF (base64) e a mensagem de envio ao decisor.
// Auth: usuário logado no Lexor Hub (Bearer Firebase) OU chamada de outro sistema com o header x-api-key = LEXOR_API_KEY.
// Cada geração com consulta custa ≈ R$ 1,00 (Infosimples). Para não pagar de novo, reenvie "dados" e "debitos" da etapa anterior.
import { timingSafeEqual } from 'node:crypto';
import { getFirebaseAdmin } from './_lib/firebase-admin.js';
import { consultaCnpj, debitos } from './_lib/infosimples.js';
import { normInfosimples, normBrasilApi, analisar, mensagemContato, mensagemProposta, propostaHtml, nomeCurto } from './_lib/proposta.js';

function chaveValida(req) {
  const esperada = process.env.LEXOR_API_KEY;
  const enviada = String(req.headers['x-api-key'] || '');
  if (!esperada || !enviada) return false;
  const a = Buffer.from(enviada), b = Buffer.from(esperada);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function autorizar(req) {
  if (chaveValida(req)) return true;
  const h = req.headers.authorization || '';
  const idToken = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!idToken) return false;
  try { const { auth } = await getFirebaseAdmin(); await auth.verifyIdToken(idToken); return true; } catch { return false; }
}

// Gera o PDF e valida a proposta ANTES de entregar: cada página tem de caber na folha (ajusta o zoom se preciso),
// o texto não pode ter asteriscos/"undefined", e o PDF final tem de ter exatamente as páginas esperadas.
const PAGINAS_ESPERADAS = 4;
async function pdfValidado(html, dados) {
  const [{ default: chromium }, { default: puppeteer }] = await Promise.all([import('@sparticuz/chromium'), import('puppeteer-core')]);
  const browser = await puppeteer.launch({
    args: chromium.args, executablePath: process.env.CHROMIUM_PATH || await chromium.executablePath(), headless: 'shell',
  });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'load', timeout: 30000 });
    await page.emulateMediaType('print');
    const rel = await page.evaluate(async () => {
      try { await document.fonts.ready; } catch {}
      const pgs = [...document.querySelectorAll('.pg')];
      const fit = pgs.map((el, i) => {
        let z = 1;
        while (el.scrollHeight > el.clientHeight + 1 && z > 0.72) { z = +(z - 0.03).toFixed(2); el.style.zoom = z; }
        return { pagina: i + 1, zoom: z, sobra: Math.max(0, el.scrollHeight - el.clientHeight) };
      });
      return { fit, texto: document.body.innerText, paginas: pgs.length + document.querySelectorAll('.cover').length };
    });
    const pdf = Buffer.from(await page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true }));
    const nPaginas = (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
    const checks = [
      { item: 'Cada página cabe na folha', ok: rel.fit.every((f) => f.sobra === 0), detalhe: rel.fit.map((f) => `p${f.pagina + 1}${f.zoom < 1 ? ' zoom ' + f.zoom : ''}${f.sobra ? ' ESTOURA ' + f.sobra + 'px' : ''}`).join(', ') },
      { item: `PDF com ${PAGINAS_ESPERADAS} páginas`, ok: nPaginas === PAGINAS_ESPERADAS, detalhe: `${nPaginas} páginas` },
      { item: 'Sem asteriscos no texto', ok: !/\*/.test(rel.texto) },
      { item: 'Sem valores vazios (undefined/null/NaN)', ok: !/undefined|\bnull\b|NaN|\[object/.test(rel.texto) },
      { item: 'Nome da empresa presente', ok: !!dados.razao_social && rel.texto.toLowerCase().includes(String(dados.razao_social).toLowerCase().slice(0, 12)) },
      { item: 'Identidade Labora presente', ok: /Labora Contabilidade e Gestão/.test(rel.texto) },
    ];
    return { pdf, validacao: { ok: checks.every((c) => c.ok), checks } };
  } finally { await browser.close(); }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  if (!(await autorizar(req))) return res.status(401).json({ error: 'nao_autorizado' });

  const b = req.body || {};
  const cnpj = String(b.cnpj || '').replace(/\D/g, '');
  if (cnpj.length !== 14) return res.status(400).json({ error: 'cnpj_invalido' });
  const etapa = b.etapa === 'proposta' ? 'proposta' : 'contato';
  if (!process.env.INFOSIMPLES_TOKEN && !(b.dados && b.debitos)) return res.status(500).json({ error: 'INFOSIMPLES_TOKEN_ausente' });

  try {
    // 1) Ficha da empresa (reaproveita b.dados quando enviado; reserva: BrasilAPI)
    let dados = b.dados;
    if (!dados) {
      try { dados = normInfosimples(await consultaCnpj(cnpj)); }
      catch (e) {
        if (/\b612:/.test(e.message)) return res.status(404).json({ error: 'cnpj_nao_encontrado' });
        const r = await fetch('https://brasilapi.com.br/api/cnpj/v1/' + cnpj);
        if (!r.ok) return res.status(r.status === 404 ? 404 : 502).json({ error: 'cnpj_indisponivel' });
        dados = normBrasilApi(await r.json());
      }
    }
    // 2) Débitos (reaproveita b.debitos; consultas que falharam podem ser refeitas reenviando sem elas)
    const deb = b.debitos || await debitos(cnpj);
    const a = analisar(dados, deb);
    const opts = { contato: b.contato || '', decisor: b.decisor || '' };

    const out = { etapa, empresa: nomeCurto(dados), dados, debitos: deb, diagnostico: { diag: a.diag, oportunidades: a.oportunidades }, mensagem: mensagemContato(dados, a, opts) };
    if (etapa === 'proposta') {
      const html = propostaHtml(dados, a, { decisor: opts.decisor, valores: b.valores || {}, numero: b.numero || '' });
      const { pdf, validacao } = await pdfValidado(html, dados);
      if (!validacao.ok) return res.status(422).json({ error: 'proposta_reprovada_na_validacao', validacao });
      out.validacao = validacao;
      out.mensagem = mensagemProposta(dados, a, opts);
      out.mensagem_contato = mensagemContato(dados, a, opts);
      out.arquivo = { nome: `Proposta-${nomeCurto(dados).replace(/\s+/g, '-')}.pdf`, tipo: 'application/pdf', base64: pdf.toString('base64') };
    }
    return res.status(200).json(out);
  } catch (e) {
    return res.status(502).json({ error: 'falha_geracao', detalhe: e.message });
  }
}
