// LLM access. Read-only: it returns JSON and can never write anywhere.
// The only tool it can ever get is Google Search (for fact-checking), which is read-only.
// Gemini via REST (free tier at aistudio.google.com) or a deterministic mock.

// Search-grounded calls can't use JSON mode, so the JSON is extracted from plain text.
function extractJson(text) {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start === -1 || end <= start) throw new Error('no JSON object found');
    return JSON.parse(cleaned.slice(start, end + 1));
  }
}

// Turns a 429 into a clear decision: daily quota = stop now, per-minute limit = wait and retry.
async function quotaError(res, model) {
  let body = {};
  try {
    body = await res.json();
  } catch {
    /* ignore */
  }
  const details = body.error?.details ?? [];
  const daily = details.flatMap((d) => d.violations ?? []).some((v) => /PerDay/i.test(v.quotaId ?? ''));
  const delaySec = parseInt(details.find((d) => d.retryDelay)?.retryDelay ?? '', 10);
  if (daily) {
    const hours = Number.isFinite(delaySec) ? ` Resets in about ${Math.ceil(delaySec / 3600)} hour(s).` : '';
    return Object.assign(new Error(`Gemini daily free-tier quota used up for ${model}.${hours} (Or enable billing in Google AI Studio.)`), { retry: false });
  }
  return Object.assign(new Error(`Gemini rate limit (HTTP 429) for ${model}`), { retry: true, waitMs: Math.min((Number.isFinite(delaySec) ? delaySec : 10) * 1000, 60000) });
}

export function createLlm({ mock, maxCalls, trace, models = {} }) {
  let calls = 0;

  /**
   * schema: forces the exact JSON structure (not allowed together with search).
   * search: lets Gemini verify facts with Google Search; result.__sources lists what it read.
   */
  async function generateJson(purpose, prompt, mockResponse, { temperature = 0.7, schema, search = false } = {}) {
    if (calls >= maxCalls) throw new Error(`LLM call cap reached (${maxCalls} per run)`);
    calls++;
    const started = Date.now();

    if (mock) {
      const result = mockResponse();
      trace.llmCall({ purpose, model: 'mock', ms: Date.now() - started, inputTokens: 0, outputTokens: 0 });
      return result;
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY is missing (set it in .env, or run with --mock)');
    // Per-step model from config.models (e.g. a lighter model for scoring), else the default.
    const model = models[purpose.replace(/-retry$/, '')] || process.env.GEMINI_MODEL || 'gemini-2.5-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

    let lastError;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            ...(search
              ? { tools: [{ google_search: {} }], generationConfig: { temperature } }
              : { generationConfig: { responseMimeType: 'application/json', temperature, ...(schema ? { responseSchema: schema } : {}) } }),
          }),
          signal: AbortSignal.timeout(search ? 150000 : 90000),
        });
        if (res.status === 429) throw await quotaError(res, model);
        if (res.status >= 500) throw Object.assign(new Error(`Gemini HTTP ${res.status} (${model})`), { retry: true });
        if (!res.ok) throw new Error(`Gemini HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);

        const data = await res.json();
        const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
        const grounding = data.candidates?.[0]?.groundingMetadata;
        const sources = (grounding?.groundingChunks ?? [])
          .map((c) => c.web?.title)
          .filter(Boolean)
          .filter((t, i, all) => all.indexOf(t) === i);
        trace.llmCall({
          purpose,
          model,
          ms: Date.now() - started,
          inputTokens: data.usageMetadata?.promptTokenCount ?? 0,
          outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
          ...(search ? { searches: grounding?.webSearchQueries ?? [], sources } : {}),
        });
        let parsed;
        try {
          parsed = search ? extractJson(text) : JSON.parse(text);
        } catch {
          throw new Error(`Gemini returned invalid JSON for "${purpose}" (finish reason: ${data.candidates?.[0]?.finishReason ?? 'unknown'}): ${text.slice(0, 200)}`);
        }
        if (search) {
          parsed.__sources = sources;
          parsed.__searches = grounding?.webSearchQueries ?? [];
        }
        return parsed;
      } catch (error) {
        lastError = error;
        const retryable = error.retry || error.name === 'TimeoutError';
        if (!retryable || attempt === 3) break;
        await new Promise((r) => setTimeout(r, error.waitMs ?? 2000 * 2 ** attempt)); // Google's retry hint, else 4s, 8s
      }
    }
    throw lastError;
  }

  return { generateJson, get calls() { return calls; } };
}
