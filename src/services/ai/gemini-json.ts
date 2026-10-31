import { AppError } from '../../utils/response';

/** Generate and parse one JSON response from the organization-configured Gemini model. */
export async function generateGeminiJson<T = unknown>(prompt: string, maxOutputTokens = 2048): Promise<T> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new AppError('AI service is not configured. Set GEMINI_API_KEY on the backend.', 503, 'AI_NOT_CONFIGURED');

  const model = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const axios = await import('axios');
  let response;
  try {
    response = await axios.default.post(endpoint, {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens, responseMimeType: 'application/json' },
    }, {
      headers: { 'x-goog-api-key': apiKey, 'content-type': 'application/json' },
      timeout: 120_000,
    });
  } catch (error: any) {
    const status = error?.response?.status;
    if (error?.code === 'ECONNABORTED' || error?.code === 'ETIMEDOUT') {
      throw new AppError('The AI request timed out. Please try again.', 504, 'AI_TIMEOUT');
    }
    if (status === 401 || status === 403) {
      throw new AppError('Gemini rejected the configured API key. Check GEMINI_API_KEY on the backend.', 502, 'AI_AUTH_FAILED');
    }
    if (status === 404) {
      throw new AppError(`The configured Gemini model "${model}" was not found. Check GEMINI_MODEL.`, 502, 'AI_MODEL_NOT_FOUND');
    }
    if (status === 429) throw new AppError('Gemini is temporarily rate limited. Please try again shortly.', 503, 'AI_RATE_LIMITED');
    throw new AppError('Gemini could not complete this analysis. Please try again.', 502, 'AI_PROVIDER_ERROR');
  }

  const text = (response.data?.candidates?.[0]?.content?.parts ?? [])
    .map((part: { text?: string }) => part.text ?? '')
    .join('\n')
    .trim();
  if (!text) throw new AppError('Gemini returned an empty response. Please try again.', 502, 'AI_INVALID_RESPONSE');

  try {
    const normalized = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    return JSON.parse(normalized) as T;
  } catch {
    throw new AppError('Gemini returned an invalid JSON response. Please try again.', 502, 'AI_INVALID_RESPONSE');
  }
}
