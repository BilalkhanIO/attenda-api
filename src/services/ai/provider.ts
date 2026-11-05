import axios from 'axios';
import { AppError } from '../../utils/response';
import { logger } from '../../utils/logger';

export type LLMToolDefinition = { name: string; description: string; parameters: Record<string, unknown> };
export type LLMMessage = {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  tool_call_id?: string;
  tool_name?: string;
};
export type LLMToolTurn = { content: string; tool_calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>; provider: 'gemini' | 'openai'; usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number } };

type ProviderName = 'gemini' | 'openai';
type Circuit = { failures: number; openUntil: number };
const circuits = new Map<ProviderName, Circuit>();
const FAILURE_LIMIT = 3;
const OPEN_MS = 30_000;

function configuredProviders(): ProviderName[] {
  const primary = process.env.AI_PRIMARY_PROVIDER === 'openai' ? 'openai' : 'gemini';
  const fallback = primary === 'gemini' ? 'openai' : 'gemini';
  const hasKey = (provider: ProviderName) => provider === 'gemini' ? !!process.env.GEMINI_API_KEY : !!process.env.AI_OPENAI_API_KEY;
  const providers: ProviderName[] = [primary, fallback];
  return providers.filter((provider, index, all) => hasKey(provider) && all.indexOf(provider) === index);
}

function canCall(name: ProviderName) {
  const circuit = circuits.get(name);
  if (!circuit || circuit.openUntil <= Date.now()) return true;
  return false;
}
function recordSuccess(name: ProviderName) { circuits.set(name, { failures: 0, openUntil: 0 }); }
function recordFailure(name: ProviderName, error: unknown) {
  const next = (circuits.get(name)?.failures ?? 0) + 1;
  const openUntil = next >= FAILURE_LIMIT ? Date.now() + OPEN_MS : 0;
  circuits.set(name, { failures: next, openUntil });
  const detail = error as { code?: string; response?: { status?: number } };
  logger.warn({ provider: name, failures: next, circuit_open: !!openUntil, code: detail?.code, status: detail?.response?.status }, 'LLM provider attempt failed');
}

function geminiEndpoint() {
  const model = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
  return `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
}

async function geminiCall(system: string, messages: LLMMessage[], tools?: LLMToolDefinition[]): Promise<LLMToolTurn> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('Gemini is not configured');
  const contents: Array<{ role: 'user' | 'model'; parts: Array<Record<string, unknown>> }> = [];
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message.role === 'tool') {
      const previous = contents[contents.length - 1];
      const functionResponse = { functionResponse: { name: message.tool_name, response: { result: message.content } } };
      if (previous?.role === 'user' && previous.parts.some(part => 'functionResponse' in part)) previous.parts.push(functionResponse);
      else contents.push({ role: 'user', parts: [functionResponse] });
      continue;
    }
    if (message.role === 'assistant' && message.tool_calls?.length) {
      contents.push({ role: 'model', parts: [
        ...(message.content ? [{ text: message.content }] : []),
        ...message.tool_calls.map(call => ({ functionCall: { name: call.name, args: call.arguments } })),
      ] });
      continue;
    }
    if (message.content.trim()) contents.push({ role: message.role === 'assistant' ? 'model' : 'user', parts: [{ text: message.content }] });
  }
  const functionDeclarations = tools?.length ? [{ functionDeclarations: tools.map(({ name, description, parameters }) => ({ name, description, parameters })) }] : undefined;
  const response = await axios.post(geminiEndpoint(), {
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    contents,
    ...(functionDeclarations ? { tools: functionDeclarations } : {}),
    generationConfig: { maxOutputTokens: 2048, ...(tools?.length ? {} : { responseMimeType: 'application/json' }) },
  }, { headers: { 'x-goog-api-key': apiKey, 'content-type': 'application/json' }, timeout: 120_000 });
  const parts = response.data?.candidates?.[0]?.content?.parts ?? [];
  const usage = response.data?.usageMetadata;
  return {
    content: parts.map((part: any) => typeof part.text === 'string' ? part.text : '').filter(Boolean).join('\n').trim(),
    tool_calls: parts.filter((part: any) => part.functionCall?.name).map((part: any, index: number) => ({ id: `gemini-${index}`, name: part.functionCall.name, arguments: part.functionCall.args ?? {} })),
    provider: 'gemini',
    ...(usage ? { usage: { prompt_tokens: Number(usage.promptTokenCount ?? 0), completion_tokens: Number(usage.candidatesTokenCount ?? 0), total_tokens: Number(usage.totalTokenCount ?? 0) } } : {}),
  };
}

async function openAiCall(system: string, messages: LLMMessage[], tools?: LLMToolDefinition[]): Promise<LLMToolTurn> {
  const key = process.env.AI_OPENAI_API_KEY;
  if (!key) throw new Error('OpenAI-compatible fallback is not configured');
  const base = (process.env.AI_OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
  const normalized = [
    ...(system ? [{ role: 'system', content: system }] : []),
    ...messages.map(message => message.role === 'tool'
      ? { role: 'tool', tool_call_id: message.tool_call_id, content: message.content }
      : { role: message.role, content: message.content, ...(message.tool_calls?.length ? { tool_calls: message.tool_calls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) } : {}) }),
  ];
  const response = await axios.post(`${base}/chat/completions`, {
    model: process.env.AI_OPENAI_MODEL || 'gpt-4o-mini',
    messages: normalized,
    ...(tools?.length ? { tools: tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } })) } : { response_format: { type: 'json_object' } }),
    ...(tools?.length ? {} : { temperature: 0.1 }),
  }, { headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, timeout: 120_000 });
  const message = response.data?.choices?.[0]?.message;
  const usage = response.data?.usage;
  return {
    content: typeof message?.content === 'string' ? message.content.trim() : '',
    tool_calls: (message?.tool_calls ?? []).map((call: any) => ({ id: call.id, name: call.function?.name, arguments: JSON.parse(call.function?.arguments || '{}') })),
    provider: 'openai',
    ...(usage ? { usage: { prompt_tokens: Number(usage.prompt_tokens ?? 0), completion_tokens: Number(usage.completion_tokens ?? 0), total_tokens: Number(usage.total_tokens ?? 0) } } : {}),
  };
}

export async function generateToolTurn(system: string, messages: LLMMessage[], tools?: LLMToolDefinition[]): Promise<LLMToolTurn> {
  const providers = configuredProviders();
  if (!providers.length) throw new AppError('AI service is not configured. Set GEMINI_API_KEY or the fallback provider credentials on the backend.', 503, 'AI_NOT_CONFIGURED');
  const available = providers.filter(canCall);
  if (!available.length) throw new AppError('AI providers are temporarily unavailable. Please retry shortly.', 503, 'AI_PROVIDER_CIRCUIT_OPEN');
  const chain = available;
  let lastError: unknown;
  for (const provider of chain) {
    try {
      const result = provider === 'gemini' ? await geminiCall(system, messages, tools) : await openAiCall(system, messages, tools);
      if (!result.content && !result.tool_calls.length) throw new Error(`${provider} returned an empty response`);
      recordSuccess(provider);
      return result;
    } catch (error) {
      lastError = error;
      recordFailure(provider, error);
    }
  }
  const failure = lastError as any;
  if (failure?.code === 'ECONNABORTED' || failure?.code === 'ETIMEDOUT') throw new AppError('The AI request timed out. Please try again.', 504, 'AI_TIMEOUT');
  throw new AppError('Configured AI providers could not complete the request. Please try again.', 502, 'AI_PROVIDER_ERROR');
}

export function resetProviderCircuitsForTests() { circuits.clear(); }
