// Safety rules enforced in code: kill switch, rate caps, idempotency.
import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';

export const DATA_DIR = new URL('../../data/', import.meta.url);
const STATE_FILE = new URL('state.json', DATA_DIR);
const MOCK_STATE_FILE = new URL('state-mock.json', DATA_DIR);
const KILL_FILE = new URL('../KILL_SWITCH', import.meta.url); // agent/KILL_SWITCH

/** True if the agent must stop. Checked at start AND right before every external write. */
export function killSwitchActive() {
  if (String(process.env.KILL_SWITCH).toLowerCase() === 'true') return 'KILL_SWITCH=true in environment';
  if (existsSync(KILL_FILE)) return 'agent/KILL_SWITCH file exists';
  return null;
}

// Mock runs keep separate memory so test runs never count toward real caps.
const stateFile = (mock) => (mock ? MOCK_STATE_FILE : STATE_FILE);

export async function loadState(mock = false) {
  let text;
  try {
    text = await readFile(stateFile(mock), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { published: [] }; // first run
    throw error;
  }
  // A corrupted file must stop the run: an empty state would silently reset caps and duplicate checks.
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('data/state.json is corrupted. Fix or delete it manually before running again.');
  }
}

export async function saveState(state, mock = false) {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(stateFile(mock), JSON.stringify(state, null, 2));
}

export function postsThisWeek(state) {
  const weekAgo = Date.now() - 7 * 86400000;
  return state.published.filter((p) => new Date(p.at).getTime() > weekAgo).length;
}

/** Returns a reason string if publishing is NOT allowed, otherwise null. */
export function checkRateCaps(state, config, postsThisRun) {
  if (postsThisRun >= config.maxPostsPerRun) return `Run cap reached (${config.maxPostsPerRun} per run)`;
  const week = postsThisWeek(state);
  if (week >= config.maxPostsPerWeek) return `Weekly cap reached (${week}/${config.maxPostsPerWeek} in the last 7 days)`;
  return null;
}
