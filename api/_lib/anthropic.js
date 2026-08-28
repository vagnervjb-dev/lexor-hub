// Carrega o SDK da Anthropic apenas quando uma requisição autenticada realmente
// precisa usar IA. Imports estáticos deste pacote derrubavam a função durante a
// avaliação do módulo na Vercel, antes de o handler conseguir responder.
let dependenciesPromise;

export function getAnthropicDependencies() {
  if (!dependenciesPromise) {
    dependenciesPromise = initializeAnthropicDependencies().catch((error) => {
      dependenciesPromise = undefined;
      throw error;
    });
  }
  return dependenciesPromise;
}

async function initializeAnthropicDependencies() {
  const rawApiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!rawApiKey) {
    throw new Error('Variável ausente na Vercel: ANTHROPIC_API_KEY');
  }

  const quote = rawApiKey[0];
  const apiKey = (quote === '"' || quote === "'") && rawApiKey.at(-1) === quote
    ? rawApiKey.slice(1, -1)
    : rawApiKey;
  if (!apiKey.startsWith('sk-ant-')) {
    throw new Error('ANTHROPIC_API_KEY inválida: a chave deve começar com "sk-ant-".');
  }

  const [{ default: Anthropic }, { z }, { zodOutputFormat }] = await Promise.all([
    import('@anthropic-ai/sdk'),
    import('zod/v4'),
    import('@anthropic-ai/sdk/helpers/zod'),
  ]);

  return {
    anthropic: new Anthropic({ apiKey }),
    z,
    zodOutputFormat,
  };
}
