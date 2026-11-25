// Rollback: turns a live post back into a draft.
// Usage:  npm run unpublish            (the most recent live post)
//         npm run unpublish -- 12345   (a specific Dev.to article id)
// Deliberately NOT blocked by the kill switch: taking content down is always allowed.
import { loadState, saveState } from './lib/guards.js';
import { getPublisher } from './lib/publisher.js';

const state = await loadState();
const wantedId = process.argv[2];
const post = wantedId
  ? state.published.find((p) => String(p.id) === wantedId)
  : [...state.published].reverse().find((p) => p.live);

if (!post) {
  console.log(wantedId ? `No post with id ${wantedId} in data/state.json` : 'No live posts to unpublish.');
  process.exit(wantedId ? 1 : 0);
}

try {
  const result = await getPublisher(post.publisher).unpublish(post.id);
  post.live = false;
  post.unpublishedAt = new Date().toISOString();
  await saveState(state);
  console.log(`Unpublished "${post.title}" (id ${post.id}). It is now a draft: ${result.url ?? 'https://dev.to/dashboard'}`);
} catch (error) {
  console.error(`Unpublish FAILED: ${error.message}`);
  process.exitCode = 1;
}
