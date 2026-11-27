import { createInterface } from 'node:readline/promises';
import { stdin, stderr, stdout } from 'node:process';
import { createLlm } from './lib/llm.js';
import { findLatestArticle, normalizeCompetitorUrl } from './lib/siteResearch.js';
import {
  createResearchBrief,
  formatFinding,
  reviseFromBrief,
  reviewTerminalDraft,
  verifyTerminalDraft,
  writeFromBrief,
} from './lib/terminalContent.js';

const log = (stage, message) => {
  stderr.write(`[${new Date().toISOString()}] [${stage}] ${message}\n`);
};

const MIN_WORDS = 600;
const MAX_LLM_CALLS = 20;
const PROVIDERS = {
  claude: {
    models: {
      research: 'claude-sonnet-4-5',
      write: 'claude-sonnet-4-5',
      review: 'claude-sonnet-4-5',
      revise: 'claude-sonnet-4-5',
    },
  },
  groq: {
    models: {
      research: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b'],
      write: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b'],
      review: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b'],
      revise: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b'],
    },
  },
  gemini: {
    models: {
      research: 'gemini-3.1-flash-lite',
      write: 'gemini-2.5-flash',
      review: 'gemini-2.5-flash',
      revise: 'gemini-2.5-flash',
    },
  },
};

function splitList(value) {
  return value.split(',').map((part) => part.trim()).filter(Boolean);
}

function summarizeList(items, max = 5) {
  if (!items?.length) return 'None reported';
  return items.slice(0, max).map((item) => `- ${formatFinding(item)}`).join('\n')
    + (items.length > max ? `\n- …and ${items.length - max} more` : '');
}

async function withProgress(stage, label, action) {
  const started = Date.now();
  log(stage, `${label} started`);
  const timer = setInterval(() => {
    const seconds = Math.round((Date.now() - started) / 1000);
    log(stage, `${label} is still running (${seconds}s elapsed)`);
  }, 10000);
  try {
    const result = await action();
    log(stage, `${label} finished in ${Math.round((Date.now() - started) / 1000)}s`);
    return result;
  } catch (error) {
    log(stage, `${label} failed after ${Math.round((Date.now() - started) / 1000)}s`);
    throw error;
  } finally {
    clearInterval(timer);
  }
}

async function askProfile() {
  const rl = createInterface({ input: stdin, crlfDelay: Infinity });
  const queuedLines = [];
  const waiting = [];
  let closed = false;
  rl.on('line', (line) => {
    const resolve = waiting.shift();
    if (resolve) resolve(line);
    else queuedLines.push(line);
  });
  rl.on('close', () => {
    closed = true;
    while (waiting.length) waiting.shift()(null);
  });
  const ask = async (prompt) => {
    stderr.write(prompt);
    if (queuedLines.length) return queuedLines.shift();
    if (closed) throw new Error('Input ended before all terminal questions were answered.');
    const answer = await new Promise((resolve) => waiting.push(resolve));
    if (answer === null) throw new Error('Input ended before all terminal questions were answered.');
    return answer;
  };
  try {
    const niche = (await ask('What is your blog niche? ')).trim();
    const audience = (await ask('Who is your target audience? ')).trim();
    const competitorInput = await ask('Competitor website URLs (comma-separated): ');

    if (!niche) throw new Error('Niche is required.');
    if (!audience) throw new Error('Target audience is required.');
    const rawUrls = splitList(competitorInput);
    if (!rawUrls.length) throw new Error('Enter at least one competitor website URL.');
    const competitors = [...new Set(rawUrls.map(normalizeCompetitorUrl))];
    return { niche, audience, competitors };
  } finally {
    rl.close();
  }
}

function createLlmTrace() {
  return {
    llmCall(call) {
      log('llm', `${call.purpose}: ${call.model} (${call.inputTokens + call.outputTokens} tokens, ${call.ms}ms)`);
      if (call.searches?.length) log('research', `Searches: ${call.searches.join(' | ')}`);
      if (call.sources?.length) log('research', `Sources consulted: ${call.sources.join(', ')}`);
    },
    llmFailure(failure) {
      log('llm', `${failure.provider}/${failure.model} failed${failure.attempt ? ` (attempt ${failure.attempt})` : ''}: ${failure.error}`);
      if (failure.next) log('fallback', `Next: ${failure.next.provider}/${failure.next.model}`);
    },
  };
}

function reviewPasses(review) {
  return review.verdict === 'approve'
    && !review.issues.some((issue) => issue.severity === 'critical' || issue.severity === 'major');
}

function printReview(review) {
  log('quality', `Verdict: ${review.verdict}; accuracy ${review.accuracyScore}/100, SEO ${review.seoScore}/100, intent coverage ${review.intentCoverageScore}/100, originality ${review.originalityScore}/100`);
  log('quality', review.summary);
  for (const claim of review.claimsChecked ?? [])
    log('fact-check', `${claim.result}: ${claim.claim}${claim.source ? ` (source: ${claim.source})` : ''}`);
  if (review.sources?.length) log('quality', `Review sources: ${review.sources.join(', ')}`);
  for (const issue of review.issues) log('quality', `${issue.severity.toUpperCase()}: ${issue.problem} ${issue.fix}`);
  if (!review.issues.length) log('quality', 'No review issues reported');
}

async function main() {
  try {
    const profile = await askProfile();
    const provider = 'claude';
    const fallbacks = [
      { provider: 'groq', models: PROVIDERS.groq.models },
      { provider: 'gemini', models: PROVIDERS.gemini.models },
    ];
    const configuredKeys = [
      ['Claude', 'ANTHROPIC_API_KEY'],
      ['Groq', 'GROQ_API_KEY'],
      ['Gemini', 'GEMINI_API_KEY'],
    ].filter(([, key]) => process.env[key]).map(([name]) => name);
    if (!configuredKeys.length)
      throw new Error('Add at least one of ANTHROPIC_API_KEY, GROQ_API_KEY, or GEMINI_API_KEY to .env before running the agent.');
    log('setup', 'Provider order: Claude → Groq (openai/gpt-oss-120b → openai/gpt-oss-20b) → Gemini');
    log('setup', `Configured API keys: ${configuredKeys.join(', ')}`);

    log('start', `Terminal research started for niche "${profile.niche}" and audience "${profile.audience}"`);
    log('input', `Competitors: ${profile.competitors.join(', ')}`);
    const articles = [];
    for (const competitor of profile.competitors) {
      try {
        const article = await findLatestArticle(competitor, { log: (message) => log('discover', message) });
        articles.push(article);
        log('discover', `Ready: "${article.title}" from ${article.source}`);
      } catch (error) {
        log('discover', `Failed for ${competitor}: ${error.message}`);
      }
    }
    if (!articles.length) throw new Error('No competitor articles could be extracted. Check the URLs and try again.');

    articles.sort((a, b) => {
      const aDate = a.publishedAt ? Date.parse(a.publishedAt) : -Infinity;
      const bDate = b.publishedAt ? Date.parse(b.publishedAt) : -Infinity;
      return bDate - aDate;
    });
    const selected = articles[0];
    log('discover', `Newest article selected: "${selected.title}"${selected.publishedAt ? ` (${selected.publishedAt.slice(0, 10)})` : ' (date unavailable; using first supplied site)'}`);

    const llm = createLlm({
      mock: false,
      maxCalls: MAX_LLM_CALLS,
      trace: createLlmTrace(),
      provider,
      models: PROVIDERS[provider].models,
      fallbacks,
    });
    const brief = await withProgress(
      'research',
      `Researching search intent, reader questions, claims, and gaps for "${selected.title}"`,
      () => createResearchBrief(selected, profile, { llm }),
    );
    log('research', `Search intent: ${brief.searchIntent}`);
    log('research', `Primary keyword: ${brief.primaryKeyword}; related: ${(brief.secondaryKeywords ?? []).join(', ') || 'none'}`);
    log('research', `Questions addressed:\n${summarizeList(brief.questionsAnswered)}`);
    log('research', `Reader gaps:\n${summarizeList(brief.contentGaps)}`);
    log('research', `Claims researched:\n${summarizeList(brief.claimsToVerify)}`);
    log('research', `Distinct angle: ${brief.uniqueAngle}`);
    if (brief.researchSources?.length) log('research', `Research URLs:\n${summarizeList(brief.researchSources, 10)}`);
    if (!brief.primaryKeyword || !brief.uniqueAngle || !brief.outline?.length)
      throw new Error('The research brief was incomplete; refusing to draft from it.');

    log('write', `Writing an original article from the brief (minimum ${MIN_WORDS} words); competitor article text is not sent to the writer`);
    let draft = await withProgress(
      'write',
      'Generating the original article from the research brief',
      () => writeFromBrief(brief, profile, { llm, minWords: MIN_WORDS }),
    );
    let checks = verifyTerminalDraft(draft, {
      profile,
      brief,
      competitorText: selected.text,
      minWords: MIN_WORDS,
      sources: brief.researchSources ?? [],
    });
    for (const failure of checks.failures) log('check', `FAILED: ${failure}`);
    if (!checks.failures.length) log('check', `Structural, SEO, and originality checks passed (${checks.wordCount} words)`);

    log('quality', 'Running search-grounded accuracy, SEO, intent, and originality review');
    let review = await withProgress(
      'quality',
      'Checking accuracy, SEO, search intent, and originality with current sources',
      () => reviewTerminalDraft(draft, brief, profile, { llm }),
    );
    printReview(review);

    const needsRevision = checks.failures.length > 0 || !reviewPasses(review);
    if (needsRevision) {
      const revisionIssues = [
        ...review.issues,
        ...checks.failures.map((problem) => ({ severity: 'major', problem, fix: 'Correct this deterministic check failure.' })),
      ];
      if (!revisionIssues.length)
        revisionIssues.push({
          severity: 'major',
          problem: `${review.summary} Review scores: accuracy ${review.accuracyScore}, SEO ${review.seoScore}, intent ${review.intentCoverageScore}, originality ${review.originalityScore}.`,
          fix: 'Revise the draft to meet every quality threshold and the research brief.',
        });
      log('revise', `Draft did not pass; requesting one evidence-based revision for ${revisionIssues.length} issue(s)`);
      draft = await withProgress(
        'revise',
        'Revising the article against review findings',
        () => reviseFromBrief(draft, brief, profile, { ...review, issues: revisionIssues }, { llm, minWords: MIN_WORDS }),
      );
      checks = verifyTerminalDraft(draft, {
        profile,
        brief,
        competitorText: selected.text,
        minWords: MIN_WORDS,
        sources: brief.researchSources ?? [],
      });
      for (const failure of checks.failures) log('check', `FAILED after revision: ${failure}`);
      if (!checks.failures.length) log('check', `Structural, SEO, and originality checks passed after revision (${checks.wordCount} words)`);
      review = await withProgress(
        'quality',
        'Rechecking the revised article with current web sources',
        () => reviewTerminalDraft(draft, brief, profile, { llm }),
      );
      printReview(review);
    }

    if (checks.failures.length || !reviewPasses(review)) {
      const reasons = [
        ...checks.failures,
        ...(reviewPasses(review) ? [] : [`Review did not approve the article (${review.verdict}): ${review.summary}`]),
      ];
      throw new Error(`Article not printed because it did not pass quality gates: ${reasons.join('; ')}`);
    }

    log('complete', 'All research, SEO, originality, and accuracy checks passed. Printing the article now.');
    stdout.write(`# ${draft.title}\n\n> ${draft.meta_description}\n\n${draft.body_markdown.trim()}\n`);
  } catch (error) {
    log('error', error.message);
    process.exitCode = 1;
  }
}

await main();
