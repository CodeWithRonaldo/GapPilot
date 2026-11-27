import assert from 'node:assert/strict';
import test from 'node:test';
import {
  calculateTextOverlap,
  createResearchBrief,
  formatFinding,
  verifySeoDraft,
  verifyTerminalDraft,
  writeFromBrief,
} from '../lib/terminalContent.js';

test('detects copied long phrases but permits an independent treatment of the topic', () => {
  const source = 'A practical guide explains every step carefully, with clear examples for readers who are learning this topic today.';
  const copied = calculateTextOverlap(source, source);
  const original = calculateTextOverlap(source, 'Readers can begin with a small experiment and compare the results against their actual needs.');
  assert.equal(copied.ratio, 1);
  assert.equal(original.ratio, 0);
});

test('formats object-shaped research claims as readable findings', () => {
  assert.equal(
    formatFinding({ claim: 'A claim to verify', finding: 'Confirmed by a primary source', source: 'https://example.com' }),
    'A claim to verify — Confirmed by a primary source — https://example.com',
  );
});

test('SEO checks require the target phrase in the title and opening', () => {
  const brief = { primaryKeyword: 'garden planning' };
  const draft = {
    title: 'A practical guide to garden planning',
    meta_description: 'Plan a productive garden with practical steps.',
    body_markdown: 'Garden planning starts with your space.\n\n## Choose a location\n\n## Pick plants\n\n## Make a schedule\n\n## FAQ\n\n### When should I start?\nStart now.',
  };
  assert.deepEqual(verifySeoDraft(draft, brief), []);
  assert.match(verifySeoDraft({ ...draft, title: 'A practical outdoor guide' }, brief)[0], /title/);
});

test('terminal quality checks report short articles and excessive source overlap', () => {
  const copiedPhrase = 'Garden planning starts by observing your sunlight and recording the available space before choosing plants carefully.';
  const draft = {
    title: 'A practical guide to garden planning',
    slug: 'garden-planning',
    meta_description: 'Plan a productive garden with practical steps.',
    tags: [],
    faq: [{ q: 'When?', a: 'Now.' }],
    body_markdown: `${copiedPhrase}\n\n## One\n\n## Two\n\n## Three\n\n## FAQ\n\n### When?\nNow.`,
  };
  const checks = verifyTerminalDraft(draft, {
    profile: { niche: 'gardening' },
    brief: { primaryKeyword: 'garden planning' },
    competitorText: `${copiedPhrase} ${copiedPhrase}`,
    minWords: 600,
    sources: [],
  });
  assert.ok(checks.failures.some((failure) => /Too short/.test(failure)));
  assert.ok(checks.failures.some((failure) => /overlap/.test(failure)));
});

test('writer receives only the distilled brief, not the competitor article text', async () => {
  const competitorPhrase = 'PRIVATE COMPETITOR PARAGRAPH SHOULD NEVER REACH THE WRITER';
  let researchPrompt = '';
  let writerPrompt = '';
  const llm = {
    async generateJson(_purpose, prompt) {
      researchPrompt = prompt;
      return {
        primaryKeyword: 'garden planning',
        secondaryKeywords: ['planting schedule'],
        searchIntent: 'Learn how to plan a garden.',
        questionsAnswered: ['How do I start?'],
        claimsToVerify: ['Plants need suitable light.'],
        contentGaps: ['Small-space examples'],
        uniqueAngle: 'A small-space, beginner-friendly plan.',
        outline: ['Assess the space', 'Choose plants', 'Plan a schedule'],
        researchSummary: 'Use local light and climate conditions.',
        __searches: ['garden planning search intent'],
        __sourceUrls: ['https://example.com/gardening-guide'],
      };
    },
    async generateText(_purpose, prompt) {
      writerPrompt = prompt;
      return {
        text: `TITLE: A guide to garden planning\nMETA: Practical steps for better garden planning.\nTAGS: gardening, guide\n---BODY---\n${'Garden planning helps you organize your space and choose suitable plants. '.repeat(100)}\n\n## FAQ\n\n### Is planning useful?\nYes.\n`,
      };
    },
  };
  const profile = { niche: 'gardening', audience: 'new gardeners', keywords: [] };
  const article = {
    title: 'Competitor article',
    excerpt: 'A short excerpt.',
    text: `${competitorPhrase} ${'Full competitor text. '.repeat(100)}`,
    publishedAt: null,
    url: 'https://example.com/post',
  };
  const brief = await createResearchBrief(article, profile, { llm });
  await writeFromBrief(brief, profile, { llm, minWords: 600 });
  assert.match(researchPrompt, new RegExp(competitorPhrase));
  assert.doesNotMatch(writerPrompt, new RegExp(competitorPhrase));
  assert.match(writerPrompt, /small-space, beginner-friendly plan/);
});
