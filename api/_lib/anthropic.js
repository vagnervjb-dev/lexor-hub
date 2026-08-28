// Cliente mínimo da Messages API da Anthropic usando somente fetch nativo.
// O SDK oficial traz dependências com formatos ESM/CJS incompatíveis entre si
// no empacotador da Vercel. A chamada HTTP direta preserva a API oficial e
// remove essa cadeia de carregamento do runtime.
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

function getApiKey() {
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
  return apiKey;
}

export function assertAnthropicConfigured() {
  getApiKey();
}

export async function createStructuredMessage({ messages, schema, maxTokens = 4096 }) {
  const response = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': getApiKey(),
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5',
      max_tokens: maxTokens,
      messages,
      output_config: {
        format: {
          type: 'json_schema',
          schema,
        },
      },
    }),
  });

  const raw = await response.text();
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new Error(`Anthropic respondeu conteúdo inválido (HTTP ${response.status}).`);
  }

  if (!response.ok) {
    const detail = payload?.error?.message || payload?.error?.type || `HTTP ${response.status}`;
    throw new Error(`Anthropic ${response.status}: ${detail}`);
  }

  const outputText = payload.content?.find((block) => block.type === 'text')?.text;
  if (!outputText) {
    throw new Error('Anthropic não devolveu conteúdo estruturado.');
  }

  try {
    return JSON.parse(outputText);
  } catch {
    throw new Error('Anthropic devolveu uma saída que não é JSON válido.');
  }
}
