import assert from 'node:assert/strict';
import test from 'node:test';
import { createLlm } from '../lib/llm.js';

test('tries Claude, both Groq models, then Gemini in order', async () => {
  const originalFetch = globalThis.fetch;
  const oldClaudeKey = process.env.ANTHROPIC_API_KEY;
  const oldGroqKey = process.env.GROQ_API_KEY;
  const oldGeminiKey = process.env.GEMINI_API_KEY;
  const attempted = [];
  const failures = [];
  process.env.ANTHROPIC_API_KEY = 'test-claude-key';
  process.env.GROQ_API_KEY = 'test-groq-key';
  process.env.GEMINI_API_KEY = 'test-gemini-key';
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    if (String(url).includes('api.anthropic.com')) {
      attempted.push(body.model);
      assert.equal(options.headers['x-api-key'], 'test-claude-key');
      assert.equal(options.headers['anthropic-version'], '2023-06-01');
      return new Response(JSON.stringify({ type: 'error', error: { message: 'invalid request' } }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (String(url).includes('api.groq.com')) {
      attempted.push(body.model);
      return new Response(JSON.stringify({ error: { message: 'per day token limit reached' } }), {
        status: 429,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    attempted.push(body.contents ? 'gemini-model' : 'unexpected-provider');
    return new Response(JSON.stringify({
      candidates: [{
        content: { parts: [{ text: '{"ready":true}' }] },
        groundingMetadata: { webSearchQueries: ['test query'], groundingChunks: [] },
      }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  try {
    const llm = createLlm({
      mock: false,
      maxCalls: 5,
      trace: { llmCall() {}, llmFailure: (failure) => failures.push(failure) },
      provider: 'claude',
      models: { research: 'claude-sonnet-4-5' },
      fallbacks: [
        { provider: 'groq', models: { research: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b'] } },
        { provider: 'gemini', models: { research: 'gemini-model' } },
      ],
    });
    const result = await llm.generateJson('research', 'Find the current information.', () => ({}), { search: true });
    assert.deepEqual(attempted, ['claude-sonnet-4-5', 'openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'gemini-model']);
    assert.equal(result.ready, true);
    assert.deepEqual(result.__searches, ['test query']);
    assert.equal(failures.length, 3);
  } finally {
    globalThis.fetch = originalFetch;
    if (oldClaudeKey == null) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = oldClaudeKey;
    if (oldGroqKey == null) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = oldGroqKey;
    if (oldGeminiKey == null) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = oldGeminiKey;
  }
});

test('parses Claude web search results and JSON text', async () => {
  const originalFetch = globalThis.fetch;
  const oldClaudeKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'test-claude-key';
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), 'https://api.anthropic.com/v1/messages');
    const body = JSON.parse(options.body);
    assert.equal(body.tools[0].type, 'web_search_20250305');
    assert.equal(body.max_tokens, 8192);
    return new Response(JSON.stringify({
      content: [
        { type: 'server_tool_use', name: 'web_search', input: { query: 'example query' } },
        { type: 'web_search_tool_result', content: [{ title: 'Example source', url: 'https://example.com/article' }] },
        { type: 'text', text: '{"ready":true}' },
      ],
      stop_reason: 'end_turn',
      usage: { input_tokens: 12, output_tokens: 8 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  try {
    const llm = createLlm({
      mock: false,
      maxCalls: 1,
      trace: { llmCall() {} },
      provider: 'claude',
      models: { research: 'claude-sonnet-4-5' },
    });
    const result = await llm.generateJson('research', 'Find current information.', () => ({}), { search: true });
    assert.equal(result.ready, true);
    assert.deepEqual(result.__searches, ['example query']);
    assert.deepEqual(result.__sources, ['Example source']);
    assert.deepEqual(result.__sourceUrls, ['https://example.com/article']);
  } finally {
    globalThis.fetch = originalFetch;
    if (oldClaudeKey == null) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = oldClaudeKey;
  }
});
