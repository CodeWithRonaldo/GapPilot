// LLM access. Read-only: it returns JSON and can never write anywhere.
// The only tool it can ever get is web search (for fact-checking), which is read-only.
// Providers: Groq (default) or Gemini, chosen with "provider" in config.json. Plus a deterministic mock.
//
// Same interface for both providers:
//   generateJson(purpose, prompt, mockResponse, { temperature, schema, search })
//   search: true → the model may search the web; the result gets __searches (queries) and __sources (titles).

// Search calls can't use JSON mode, so the JSON is extracted from plain text.
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

const unique = (list) => list.filter((x, i, all) => x && all.indexOf(x) === i);
const fail = (message, extra = {}) => Object.assign(new Error(message), extra);

// ---------- Groq (OpenAI-compatible API) ----------
const groq = {
  keyName: 'GROQ_API_KEY',

  async call({ model, prompt, temperature, search, json, maxTokens, reasoning, apiKey }) {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature,
        // Explicit output budget (the default is too small for a full article). Groq counts this
        // against the per-minute token limit up front, so it is set per step, not "as high as possible".
        ...(maxTokens ? { max_completion_tokens: maxTokens } : {}),
        // gpt-oss models think before answering; "low" leaves more of the budget for the article itself.
        ...(reasoning && model.includes('gpt-oss') ? { reasoning_effort: reasoning } : {}),
        // JSON mode for normal calls. Search calls answer in text and the JSON is extracted.
        // gpt-oss models search via the built-in browser_search tool; groq/compound models search on their own.
        ...(search && !model.startsWith('groq/compound') ? { tools: [{ type: 'browser_search' }] } : {}),
        ...(json && !search ? { response_format: { type: 'json_object' } } : {}),
      }),
      signal: AbortSignal.timeout(search ? 180000 : 120000),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const message = body.error?.message ?? `HTTP ${res.status}`;
      if (res.status === 429) {
        if (/per day/i.test(message)) throw fail(`Groq daily limit reached for ${model}: ${message.slice(0, 200)}`, { retry: false });
        const wait = parseFloat(res.headers.get('retry-after') ?? message.match(/try again in ([\d.]+)s/)?.[1] ?? '10');
        throw fail(`Groq rate limit for ${model} (per-minute)`, { retry: true, waitMs: Math.min(Math.ceil(wait * 1000) + 500, 60000) });
      }
      if (res.status === 413) throw fail(`Groq request too large for ${model}'s free-tier limit: ${message.slice(0, 200)}`, { retry: false });
      if (res.status === 400 && body.error?.code === 'json_validate_failed') throw fail(`Groq produced invalid JSON (${model})`, { retry: true });
      if (res.status >= 500) throw fail(`Groq HTTP ${res.status} (${model})`, { retry: true });
      throw fail(`Groq HTTP ${res.status} (${model}): ${message.slice(0, 300)}`);
    }

    const data = await res.json();
    const message = data.choices?.[0]?.message ?? {};
    // Groq reports every tool it ran: browser_search (a query) and browser.open / browser.find (pages it read).
    const tools = Array.isArray(message.executed_tools) ? message.executed_tools : [];
    const args = (t) => {
      try {
        return JSON.parse(t.arguments ?? '{}');
      } catch {
        return {};
      }
    };
    const searches = tools.filter((t) => /search/i.test(t.type ?? t.name ?? '')).map((t) => args(t).query).filter(Boolean);
    // Sources = sites of pages it actually opened; if it opened none, the sites in its search results.
    const host = (url) => {
      try {
        return new URL(url).hostname.replace(/^www\./, '');
      } catch {
        return null;
      }
    };
    const sitesOf = (list) => list.flatMap((t) => (t.search_results?.results ?? []).map((r) => host(r.url)));
    const opened = unique(sitesOf(tools.filter((t) => /open|find/i.test(t.type ?? t.name ?? ''))));
    const sources = opened.length ? opened : unique(sitesOf(tools));

    return {
      text: message.content ?? '',
      finish: data.choices?.[0]?.finish_reason,
      inputTokens: data.usage?.prompt_tokens ?? 0,
      outputTokens: data.usage?.completion_tokens ?? 0,
      searches: unique(searches.map(String)),
      sources: unique(sources),
    };
  },
};

// ---------- Gemini ----------
const gemini = {
  keyName: 'GEMINI_API_KEY',

  async call({ model, prompt, temperature, schema, search, json, apiKey }) {
    const jsonMode = json && !search; // Gemini can't combine search with JSON mode
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        ...(search ? { tools: [{ google_search: {} }] } : {}),
        generationConfig: jsonMode
          ? { responseMimeType: 'application/json', temperature, ...(schema ? { responseSchema: schema } : {}) }
          : { temperature },
      }),
      signal: AbortSignal.timeout(search ? 150000 : 90000),
    });

    if (res.status === 429) {
      const body = await res.json().catch(() => ({}));
      const details = body.error?.details ?? [];
      const daily = details.flatMap((d) => d.violations ?? []).some((v) => /PerDay/i.test(v.quotaId ?? ''));
      const delaySec = parseInt(details.find((d) => d.retryDelay)?.retryDelay ?? '', 10);
      if (daily) {
        const hours = Number.isFinite(delaySec) ? ` Resets in about ${Math.ceil(delaySec / 3600)} hour(s).` : '';
        throw fail(`Gemini daily free-tier quota used up for ${model}.${hours}`, { retry: false });
      }
      throw fail(`Gemini rate limit for ${model}`, { retry: true, waitMs: Math.min((Number.isFinite(delaySec) ? delaySec : 10) * 1000, 60000) });
    }
    if (res.status >= 500) throw fail(`Gemini HTTP ${res.status} (${model})`, { retry: true });
    if (!res.ok) throw fail(`Gemini HTTP ${res.status} (${model}): ${(await res.text()).slice(0, 300)}`);

    const data = await res.json();
    const grounding = data.candidates?.[0]?.groundingMetadata;
    return {
      text: data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '',
      finish: data.candidates?.[0]?.finishReason,
      inputTokens: data.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
      searches: grounding?.webSearchQueries ?? [],
      sources: unique((grounding?.groundingChunks ?? []).map((c) => c.web?.title)),
    };
  },
};

const PROVIDERS = { groq, gemini };

export function providerKeyName(provider) {
  return PROVIDERS[provider]?.keyName;
}

/**
 * provider: "groq" | "gemini"
 * models:   { score, write, review, revise } model ids for that provider
 */
export function createLlm({ mock, maxCalls, trace, provider = 'groq', models = {} }) {
  let calls = 0;
  const api = PROVIDERS[provider];
  if (!mock && !api) throw new Error(`Unknown LLM provider "${provider}" (use "groq" or "gemini")`);

  // Shared core: call cap, model choice, retries, trace. `parse` turns the raw output into the result.
  async function request(purpose, prompt, mockResponse, { temperature = 0.7, schema, search = false, json = true, maxTokens, reasoning }, parse) {
    if (calls >= maxCalls) throw new Error(`LLM call cap reached (${maxCalls} per run)`);
    calls++;
    const started = Date.now();

    if (mock) {
      const result = mockResponse();
      trace.llmCall({ purpose, model: 'mock', ms: Date.now() - started, inputTokens: 0, outputTokens: 0 });
      return result;
    }

    const apiKey = process.env[api.keyName];
    if (!apiKey) throw new Error(`${api.keyName} is missing (set it in .env, or run with --mock)`);
    const model = models[purpose.replace(/-retry$/, '')];
    if (!model) throw new Error(`No ${provider} model configured for "${purpose}" in config.json → models.${provider}`);

    let lastError;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const out = await api.call({ model, prompt, temperature, schema, search, json, maxTokens, reasoning, apiKey });
        if (out.finish === 'length' || out.finish === 'MAX_TOKENS')
          throw fail(`${provider} output for "${purpose}" was cut off at the token limit (${out.outputTokens} tokens). Raise maxTokens for this step.`);
        trace.llmCall({
          purpose,
          provider,
          model,
          ms: Date.now() - started,
          inputTokens: out.inputTokens,
          outputTokens: out.outputTokens,
          ...(search ? { searches: out.searches, sources: out.sources } : {}),
        });

        return parse(out);
      } catch (error) {
        lastError = error;
        const retryable = error.retry || error.name === 'TimeoutError';
        if (!retryable || attempt === 3) break;
        await new Promise((r) => setTimeout(r, error.waitMs ?? 2000 * 2 ** attempt)); // provider's hint, else 4s, 8s
      }
    }
    throw lastError;
  }

  /** Short structured answers (scores, reviews). With search, adds __searches and __sources. */
  function generateJson(purpose, prompt, mockResponse, options = {}) {
    return request(purpose, prompt, mockResponse, { ...options, json: true }, (out) => {
      let parsed;
      try {
        parsed = options.search ? extractJson(out.text) : JSON.parse(out.text);
      } catch {
        throw fail(`${provider} returned invalid JSON for "${purpose}" (finish reason: ${out.finish ?? 'unknown'}): ${out.text.slice(0, 200)}`, { retry: true });
      }
      if (options.search) {
        parsed.__searches = out.searches;
        parsed.__sources = out.sources;
      }
      return parsed;
    });
  }

  /** Long free-form output (whole articles): plain text, no JSON escaping to break. Returns { text, searches, sources }. */
  function generateText(purpose, prompt, mockResponse, options = {}) {
    return request(purpose, prompt, mockResponse, { ...options, json: false }, (out) => {
      if (!out.text.trim()) throw fail(`${provider} returned an empty answer for "${purpose}" (finish reason: ${out.finish ?? 'unknown'})`, { retry: true });
      return { text: out.text, searches: out.searches, sources: out.sources };
    });
  }

  return { generateJson, generateText, get calls() { return calls; } };
}
