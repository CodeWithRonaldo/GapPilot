// LLM access. Read-only: it returns JSON and can never write anywhere.
// The only tool it can ever get is web search (for fact-checking), which is read-only.
// Providers: Claude, Groq, or Gemini. Plus a deterministic mock.
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

// ---------- Claude ----------
const claude = {
  keyName: 'ANTHROPIC_API_KEY',

  async call({ model, prompt, temperature, search, maxTokens, apiKey }) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens ?? 8192,
        messages: [{ role: 'user', content: prompt }],
        temperature,
        ...(search ? {
          tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }],
        } : {}),
      }),
      signal: AbortSignal.timeout(search ? 180000 : 120000),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const message = body.error?.message ?? `HTTP ${res.status}`;
      if (res.status === 429) {
        const wait = parseFloat(res.headers.get('retry-after') ?? '10');
        throw fail(`Claude rate limit for ${model}`, { retry: true, waitMs: Math.min(Math.ceil(wait * 1000), 60000) });
      }
      if (res.status === 408 || res.status === 529 || res.status >= 500)
        throw fail(`Claude HTTP ${res.status} (${model}): ${message.slice(0, 200)}`, { retry: true });
      throw fail(`Claude HTTP ${res.status} (${model}): ${message.slice(0, 300)}`);
    }

    const data = await res.json();
    const blocks = data.content ?? [];
    const uniqueUrls = (urls) => urls.filter((url, index, all) => url && all.indexOf(url) === index);
    const searches = blocks
      .filter((block) => block.type === 'server_tool_use' && block.name === 'web_search')
      .map((block) => block.input?.query)
      .filter(Boolean);
    const results = blocks.flatMap((block) => block.type === 'web_search_tool_result' ? block.content ?? [] : []);
    const citations = blocks.flatMap((block) => block.citations ?? []);
    return {
      text: blocks.filter((block) => block.type === 'text').map((block) => block.text ?? '').join(''),
      finish: data.stop_reason === 'max_tokens' ? 'length' : data.stop_reason,
      inputTokens: data.usage?.input_tokens ?? 0,
      outputTokens: data.usage?.output_tokens ?? 0,
      searches: uniqueUrls(searches.map(String)),
      sources: uniqueUrls([...results.map((result) => result.title), ...citations.map((citation) => citation.title)]),
      sourceUrls: uniqueUrls([...results.map((result) => result.url), ...citations.map((citation) => citation.url)]),
    };
  },
};

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
    const sourceUrls = unique(tools.flatMap((t) => [
      ...(t.search_results?.results ?? []).map((r) => r.url),
      args(t).url,
    ]).filter((url) => typeof url === 'string' && /^https?:\/\//i.test(url)));

    return {
      text: message.content ?? '',
      finish: data.choices?.[0]?.finish_reason,
      inputTokens: data.usage?.prompt_tokens ?? 0,
      outputTokens: data.usage?.completion_tokens ?? 0,
      searches: unique(searches.map(String)),
      sources: unique(sources),
      sourceUrls,
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
      sourceUrls: unique((grounding?.groundingChunks ?? []).map((c) => c.web?.uri).filter(Boolean)),
    };
  },
};

const PROVIDERS = { claude, groq, gemini };

export function providerKeyName(provider) {
  return PROVIDERS[provider]?.keyName;
}

/**
 * provider: "claude" | "groq" | "gemini"
 * models:   model ids, or ordered model-id arrays, by purpose for the primary provider
 * fallbacks: ordered { provider, models } entries tried after primary models fail
 */
export function createLlm({ mock, maxCalls, trace, provider = 'groq', models = {}, fallbacks = [] }) {
  let calls = 0;
  const providerChain = [{ provider, models }, ...fallbacks];
  if (!mock) {
    const invalid = providerChain.find((entry) => !PROVIDERS[entry.provider]);
    if (invalid) throw new Error(`Unknown LLM provider "${invalid.provider}" (use "claude", "groq", or "gemini")`);
  }

  // Shared core: call cap, model choice, retries, trace. `parse` turns the raw output into the result.
  async function request(purpose, prompt, mockResponse, { temperature = 0.7, schema, search = false, json = true, maxTokens, reasoning }, parse) {
    const started = Date.now();

    if (mock) {
      if (calls >= maxCalls) throw new Error(`LLM call cap reached (${maxCalls} per run)`);
      calls++;
      const result = mockResponse();
      trace.llmCall({ purpose, model: 'mock', ms: Date.now() - started, inputTokens: 0, outputTokens: 0 });
      return result;
    }

    const modelPurpose = purpose.replace(/-retry$/, '');
    const candidates = providerChain.flatMap((entry) => {
      const configured = entry.models[modelPurpose] ?? (modelPurpose === 'research' ? entry.models.score : undefined);
      return (Array.isArray(configured) ? configured : configured ? [configured] : [])
        .map((model) => ({ provider: entry.provider, api: PROVIDERS[entry.provider], model }));
    });
    if (!candidates.length) throw new Error(`No model configured for "${purpose}"`);
    let lastError;
    for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex++) {
      const candidate = candidates[candidateIndex];
      const apiKey = process.env[candidate.api.keyName];
      if (!apiKey) {
        lastError = new Error(`${candidate.api.keyName} is missing`);
        trace.llmFailure?.({
          purpose,
          provider: candidate.provider,
          model: candidate.model,
          error: lastError.message,
          next: candidates[candidateIndex + 1],
        });
        continue;
      }

      for (let attempt = 1; attempt <= 3; attempt++) {
        if (calls >= maxCalls) throw new Error(`LLM request cap reached (${maxCalls} attempts per run)`, { cause: lastError });
        calls++;
        try {
          const out = await candidate.api.call({ model: candidate.model, prompt, temperature, schema, search, json, maxTokens, reasoning, apiKey });
          if (out.finish === 'length' || out.finish === 'MAX_TOKENS')
            throw fail(`${candidate.provider} output for "${purpose}" was cut off at the token limit (${out.outputTokens} tokens). Raise maxTokens for this step.`);
          const result = parse(out, candidate.provider);
          trace.llmCall({
            purpose,
            provider: candidate.provider,
            model: candidate.model,
            ms: Date.now() - started,
            inputTokens: out.inputTokens,
            outputTokens: out.outputTokens,
            ...(search ? { searches: out.searches, sources: out.sources } : {}),
          });
          return result;
        } catch (error) {
          lastError = error;
          const retryable = error.retry || error.name === 'TimeoutError';
          const nextCandidate = !retryable || attempt === 3 ? candidates[candidateIndex + 1] : null;
          trace.llmFailure?.({
            purpose,
            provider: candidate.provider,
            model: candidate.model,
            attempt,
            error: error.message,
            ...(nextCandidate ? { next: nextCandidate } : {}),
          });
          if (!retryable || attempt === 3) break;
          await new Promise((r) => setTimeout(r, error.waitMs ?? 2000 * 2 ** attempt)); // provider's hint, else 4s, 8s
        }
      }
    }
    throw lastError ?? new Error(`All configured models failed for "${purpose}"`);
  }

  /** Short structured answers (scores, reviews). With search, adds __searches and __sources. */
  function generateJson(purpose, prompt, mockResponse, options = {}) {
    return request(purpose, prompt, mockResponse, { ...options, json: true }, (out, usedProvider) => {
      let parsed;
      try {
        parsed = options.search ? extractJson(out.text) : JSON.parse(out.text);
      } catch {
        throw fail(`${usedProvider} returned invalid JSON for "${purpose}" (finish reason: ${out.finish ?? 'unknown'}): ${out.text.slice(0, 200)}`, { retry: true });
      }
      if (options.search) {
        parsed.__searches = out.searches;
        parsed.__sources = out.sources;
        parsed.__sourceUrls = out.sourceUrls;
      }
      return parsed;
    });
  }

  /** Long free-form output (whole articles): plain text, no JSON escaping to break. */
  function generateText(purpose, prompt, mockResponse, options = {}) {
    return request(purpose, prompt, mockResponse, { ...options, json: false }, (out, usedProvider) => {
      if (!out.text.trim()) throw fail(`${usedProvider} returned an empty answer for "${purpose}" (finish reason: ${out.finish ?? 'unknown'})`, { retry: true });
      return { text: out.text, searches: out.searches, sources: out.sources, sourceUrls: out.sourceUrls };
    });
  }

  return { generateJson, generateText, get calls() { return calls; } };
}
