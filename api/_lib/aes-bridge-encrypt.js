// Import dinâmico do aes-bridge. O pacote publica build ESM e CommonJS ao
// mesmo tempo ("dual package hazard"), e um `import` estático no topo do
// arquivo faz o empacotador de funções da Vercel confundir qual carregar —
// ora falha em detectar o export nomeado no build CJS, ora tenta rodar o
// build ESM pelo carregador CJS (SyntaxError: Unexpected token 'export').
// import() dinâmico roda a resolução real do Node em tempo de execução,
// sem passar pela análise estática que causa esse problema.
let _encryptPromise;
export function getEncrypt() {
  if (!_encryptPromise) {
    _encryptPromise = import('aes-bridge').then((mod) => mod.encrypt || mod.default.encrypt);
  }
  return _encryptPromise;
}
