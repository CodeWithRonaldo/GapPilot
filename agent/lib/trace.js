// Audit trail: every run writes data/traces/<runId>.json and <runId>.md
import { mkdir, writeFile } from 'node:fs/promises';
import { DATA_DIR } from './guards.js';

export function createTrace({ mock, trigger }) {
  const startedAt = new Date();
  const runId = startedAt.toISOString().replace(/[:.]/g, '-');
  const data = {
    runId,
    startedAt: startedAt.toISOString(),
    finishedAt: null,
    mode: mock ? 'mock' : 'live',
    trigger,
    outcome: null, // drafted | no_opportunity | blocked | killed | error
    message: '',
    steps: [],
    llmCalls: [],
    sources: [],
    rejectedItems: [],
    skipped: [],
    scored: [],
    draft: null,
    published: null,
  };

  const log = (stage, message, details) => {
    data.steps.push({ at: new Date().toISOString(), stage, message, ...(details ? { details } : {}) });
    console.log(`[${stage}] ${message}`);
  };

  async function finish(outcome, message) {
    data.outcome = outcome;
    data.message = message;
    data.finishedAt = new Date().toISOString();
    log('finish', `${outcome}: ${message}`);

    const dir = new URL('traces/', DATA_DIR);
    await mkdir(dir, { recursive: true });
    await writeFile(new URL(`${runId}.json`, dir), JSON.stringify(data, null, 2));
    await writeFile(new URL(`${runId}.md`, dir), summary(data));
    console.log(`\nTrace saved: data/traces/${runId}.json`);
    return data;
  }

  return { data, log, finish, llmCall: (call) => data.llmCalls.push(call) };
}

function summary(d) {
  const lines = [
    `# GapPilot run ${d.runId}`,
    '',
    `- **Outcome:** ${d.outcome}: ${d.message}`,
    `- **Mode:** ${d.mode} · **Trigger:** ${d.trigger}`,
    `- **Sources:** ${d.sources.map((s) => `${s.name} (${s.ok ? `${s.items} items` : `failed: ${s.error}`})`).join(', ')}`,
    `- **LLM calls:** ${d.llmCalls.length} (${d.llmCalls.reduce((n, c) => n + c.inputTokens + c.outputTokens, 0)} tokens)`,
    '',
    '## Scored topics',
    '',
    '| Score | Topic | Reason |',
    '|---|---|---|',
    ...d.scored.map((s) => `| ${s.total} | ${s.title} | ${s.reason} |`),
    '',
    '## Skipped before scoring',
    '',
    ...d.skipped.map((s) => `- ${s.title}: ${s.reason}`),
    ...d.rejectedItems.map((s) => `- ⚠️ ${s.title}: ${s.reason}`),
  ];
  if (d.published) lines.push('', '## Draft created', '', `- ${d.draft.title}`, `- ${d.published.url}`);
  return lines.join('\n') + '\n';
}
