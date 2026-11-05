import { AppError } from '../../utils/response';
import { generateToolTurn } from './provider';

/** Generate and parse one JSON response from the organization-configured Gemini model. */
export async function generateGeminiJson<T = unknown>(prompt: string, maxOutputTokens = 2048): Promise<T> {
  void maxOutputTokens;
  const result = await generateToolTurn('', [{ role: 'user', content: prompt }]);
  const text = result.content;
  if (!text) throw new AppError('Gemini returned an empty response. Please try again.', 502, 'AI_INVALID_RESPONSE');

  try {
    const normalized = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    return JSON.parse(normalized) as T;
  } catch {
    throw new AppError('Gemini returned an invalid JSON response. Please try again.', 502, 'AI_INVALID_RESPONSE');
  }
}
