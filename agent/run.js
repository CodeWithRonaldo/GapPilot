// GapPilot agent: TRIGGER → MONITOR → SCORE & DECIDE → CREATE & VERIFY → GATE & ACT
// Usage:  npm run agent          (live: real feeds, Gemini, Dev.to drafts)
//         npm run agent:mock     (sample feeds, fake LLM, drafts saved locally; no keys needed)
import { readFile } from 'node:fs/promises';
import { readFeed } from './lib/feeds.js';
import { createLlm, providerKeyName } from './lib/llm.js';
import { prefilter, scoreCandidates } from './lib/score.js';
import { writeDraft, verifyDraft, saveRejectedDraft } from './lib/write.js';
import { getPublisher } from './lib/publisher.js';
import { reviewDraft, reviseDraft, decidePublish } from './lib/review.js';
import { killSwitchActive, loadState, saveState, checkRateCaps } from './lib/guards.js';
import { createTrace } from './lib/trace.js';

const mock = process.argv.includes('--mock') || process.env.MOCK === 'true';
const trigger = process.env.GITHUB_EVENT_NAME ?? (process.env.CI ? 'ci' : 'manual');

const MOCK_SOURCES = {
  myBlogFeed: 'fixtures/my-blog.xml',
  competitorFeeds: [
    { name: 'Competitor A (sample)', url: 'fixtures/competitor-a.xml' },
    { name: 'Competitor B (sample)', url: 'fixtures/competitor-b.xml' },
  ],
};

async function main() {
  const config = JSON.parse(await readFile(new URL('./config.json', import.meta.url), 'utf8'));
  if (mock) Object.assign(config, MOCK_SOURCES, { publisher: 'mock' });

  const trace = createTrace({ mock, trigger });
  const { log } = trace;

  try {
    // 1. TRIGGER
    log('trigger', `Run started (${mock ? 'mock' : 'live'} mode, trigger: ${trigger})`);
    const killed = killSwitchActive();
    if (killed) return await trace.finish('killed', `Kill switch active: ${killed}`);

    // Fail fast on missing keys, before spending any LLM calls.
    if (!mock) {
      const missing = [];
      const llmKey = providerKeyName(config.provider);
      if (!llmKey) return await trace.finish('error', `Unknown provider "${config.provider}" in config.json (use "groq" or "gemini")`);
      if (!process.env[llmKey]) missing.push(llmKey);
      if (config.publisher === 'devto' && !process.env.DEVTO_API_KEY) missing.push('DEVTO_API_KEY');
      if (missing.length) return await trace.finish('error', `Missing in .env: ${missing.join(', ')} (see .env.example)`);
    }

    // 2. MONITOR (read-only)
    const limit = config.maxItemsPerFeed;
    let archive = [];
    if (!config.myBlogFeed) {
      log('monitor', 'No blog feed configured (new blog): every topic counts as not yet covered.');
    } else {
      const mine = await readFeed('My blog', config.myBlogFeed, { mock, limit: 200 });
      trace.data.sources.push({ name: 'My blog', ok: mine.ok, items: mine.items.length, error: mine.error });
      if (!mine.ok) log('monitor', `Could not read your blog feed (${mine.error}). Continuing with an empty archive.`);
      archive = mine.items;
    }

    const competitorItems = [];
    for (const feed of config.competitorFeeds) {
      const result = await readFeed(feed.name, feed.url, { mock, limit });
      trace.data.sources.push({ name: feed.name, ok: result.ok, items: result.items.length, error: result.error });
      trace.data.rejectedItems.push(...result.rejected);
      competitorItems.push(...result.items);
      log('monitor', result.ok ? `${feed.name}: ${result.items.length} items, ${result.rejected.length} rejected` : `${feed.name}: FAILED (${result.error})`);
    }
    if (!trace.data.sources.some((s) => s.name !== 'My blog' && s.ok)) return await trace.finish('error', 'All competitor feeds failed. Nothing to analyse.');

    // 3. SCORE & DECIDE
    const state = await loadState(mock);
    const publishedKeys = new Set(state.published.map((p) => p.key));
    const { candidates, skipped } = prefilter(competitorItems, { archive, publishedKeys, config, mock });
    trace.data.skipped = skipped;
    log('score', `${candidates.length} candidates after filtering (${skipped.length} skipped)`);
    if (!candidates.length) return await trace.finish('no_opportunity', 'No qualifying opportunity found (no new topics).');

    const llm = createLlm({ mock, maxCalls: config.maxLlmCallsPerRun, trace, provider: config.provider, models: config.models?.[config.provider] });
    const scored = await scoreCandidates(candidates, { llm, config, archive });
    trace.data.scored = scored.map(({ title, source, link, total, scores, reason, angle }) => ({ title, source, link, total, scores, reason, angle }));
    const best = scored[0];
    trace.data.threshold = config.scoreThreshold;
    log('score', `Best: "${best.title}" scored ${best.total} (threshold ${config.scoreThreshold})`);
    if (best.total < config.scoreThreshold)
      return await trace.finish('no_opportunity', `No qualifying opportunity found (best score ${best.total} < ${config.scoreThreshold}).`);

    const capReason = checkRateCaps(state, config, 0);
    if (capReason) return await trace.finish('blocked', capReason);

    // 4. CREATE & VERIFY (format checks in code)
    let draft = await writeDraft(best, { llm, config, archive });
    let check = verifyDraft(draft, { config, archive });
    const recordDraft = () => {
      trace.data.draft = { title: draft.title, slug: draft.slug, meta_description: draft.meta_description, tags: draft.tags, wordCount: check.wordCount, linkCount: check.linkCount, failures: check.failures, source_topic: draft.source_topic };
    };
    const blockDraft = async (failures) => {
      trace.data.draft.savedTo = await saveRejectedDraft(draft, failures);
      return trace.finish('blocked', `Draft rejected: ${failures.join('; ')} (saved to ${trace.data.draft.savedTo})`);
    };
    recordDraft();
    log('verify', check.failures.length ? `Draft FAILED checks: ${check.failures.join('; ')}` : `Draft passed checks (${check.wordCount} words)`);
    if (check.failures.length) return await blockDraft(check.failures);

    // 4b. STRICT AI FACT-CHECK (one revision round if needed). Can be switched off with "factCheck": false.
    let review = null;
    if (config.factCheck === false) {
      log('review', 'Fact-check DISABLED in config.json ("factCheck": false): post is not fact-checked');
    } else {
      const reviewLabel = (r) => `${r.verdict}, accuracy ${r.accuracyScore}, ${r.counts.critical} critical / ${r.counts.major} major / ${r.counts.minor} minor, ${r.searches.length} searches, ${r.sources.length} sources`;
      review = await reviewDraft(draft, { llm, config });
      trace.data.reviews = [{ round: 1, ...review }];
      log('review', `Round 1: ${reviewLabel(review)}`);

      if (review.counts.critical + review.counts.major > 0) {
        draft = await reviseDraft(draft, review, { llm, config });
        check = verifyDraft(draft, { config, archive });
        recordDraft();
        log('revise', check.failures.length ? `Revision FAILED checks: ${check.failures.join('; ')}` : `Revision passed checks (${check.wordCount} words)`);
        if (check.failures.length) return await blockDraft(check.failures);

        review = await reviewDraft(draft, { llm, config });
        trace.data.reviews.push({ round: 2, ...review });
        log('review', `Round 2: ${reviewLabel(review)}`);
      }

      // Critical problems left after revision: never send anywhere, keep locally for the human.
      if (review.counts.critical > 0)
        return await blockDraft(review.issues.filter((i) => i.severity === 'critical').map((i) => `Critical: ${i.problem}`));
    }

    // 5. GATE & ACT (the only external write). Live vs draft is decided in code.
    const dayAgo = Date.now() - 86400000;
    const livePostsToday = state.published.filter((p) => p.live && new Date(p.at).getTime() > dayAgo).length;
    const decision = decidePublish({ topicScore: best.total, review, config, livePostsToday });
    trace.data.decision = decision;
    log('decide', decision.live ? 'All rules passed: publishing LIVE' : `Creating a draft instead of publishing: ${decision.reasons.join('; ')}`);

    const killedNow = killSwitchActive();
    if (killedNow) return await trace.finish('killed', `Kill switch activated before publishing: ${killedNow}`);

    const publisher = getPublisher(config.publisher);
    const result = await publisher.createPost(draft, { live: decision.live, factChecked: review !== null });
    trace.data.published = { publisher: publisher.name, ...result };
    state.published.push({ key: best.key, id: result.id, title: draft.title, url: result.url, publisher: publisher.name, live: result.live, at: new Date().toISOString() });
    await saveState(state, mock); // saved immediately so a retry can never double-post
    return await trace.finish(
      result.live ? 'published' : 'drafted',
      result.live ? `Published LIVE on ${publisher.name}: ${result.url}` : `Draft created on ${publisher.name}: ${result.url}`,
    );
  } catch (error) {
    // Fail safe: anything unexpected stops the run without publishing.
    return await trace.finish('error', error.message);
  }
}

const result = await main();
process.exitCode = result.outcome === 'error' ? 1 : 0;
