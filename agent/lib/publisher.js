// GATE & ACT stage. This is the ONLY module that holds write credentials.
// Whether a post goes live is decided in run.js by decidePublish(); this module just executes it.
import { mkdir, writeFile } from 'node:fs/promises';
import { DATA_DIR } from './guards.js';

// The note must match what actually happened: only claim a fact-check if one ran.
const disclosure = (factChecked) =>
  factChecked
    ? '\n\n---\n\n*This post was drafted with AI assistance and fact-checked by an automated AI review before publishing.*\n'
    : '\n\n---\n\n*This post was drafted with AI assistance.*\n';

function frontmatter(draft, live) {
  const yaml = (s) => JSON.stringify(s); // JSON strings are valid YAML strings
  return [
    '---',
    `title: ${yaml(draft.title)}`,
    `description: ${yaml(draft.meta_description)}`,
    `tags: [${draft.tags.map(yaml).join(', ')}]`,
    `draft: ${!live}`,
    '---',
    '',
  ].join('\n');
}

const mockPublisher = {
  name: 'mock',
  async createPost(draft, { live, factChecked = true }) {
    const dir = new URL('drafts/', DATA_DIR);
    await mkdir(dir, { recursive: true });
    await writeFile(new URL(`${draft.slug}.md`, dir), frontmatter(draft, live) + draft.body_markdown + disclosure(factChecked));
    return { id: draft.slug, url: `data/drafts/${draft.slug}.md`, live };
  },
  async unpublish(id) {
    return { id, url: `data/drafts/${id}.md` };
  },
};

function devtoHeaders() {
  const apiKey = process.env.DEVTO_API_KEY;
  if (!apiKey) throw new Error('DEVTO_API_KEY is missing');
  return { 'Content-Type': 'application/json', 'api-key': apiKey, 'User-Agent': 'GapPilot/0.1' };
}

async function devtoRequest(method, path, article) {
  const res = await fetch(`https://dev.to/api${path}`, {
    method,
    headers: devtoHeaders(),
    body: JSON.stringify({ article }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`Dev.to HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

const devtoPublisher = {
  name: 'devto',
  async createPost(draft, { live, factChecked = true }) {
    const data = await devtoRequest('POST', '/articles', {
      title: draft.title,
      body_markdown: draft.body_markdown + disclosure(factChecked),
      description: draft.meta_description,
      tags: draft.tags,
      published: live === true, // only an explicit true goes live
    });
    return { id: data.id, url: data.url ?? 'https://dev.to/dashboard', live: live === true };
  },
  async unpublish(id) {
    const data = await devtoRequest('PUT', `/articles/${encodeURIComponent(id)}`, { published: false });
    return { id: data.id, url: data.url };
  },
};

export function getPublisher(name) {
  if (name === 'mock') return mockPublisher;
  if (name === 'devto') return devtoPublisher;
  throw new Error(`Unknown publisher "${name}"`);
}
