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
  if (!process.env.ANTHROPIC_API_KEY?.trim()) {
    throw new Error('Variável ausente na Vercel: ANTHROPIC_API_KEY');
  }

  const [{ default: Anthropic }, { z }, { zodOutputFormat }] = await Promise.all([
    import('@anthropic-ai/sdk'),
    import('zod'),
    import('@anthropic-ai/sdk/helpers/zod'),
  ]);

  return {
    anthropic: new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }),
    z,
    zodOutputFormat,
  };
}
