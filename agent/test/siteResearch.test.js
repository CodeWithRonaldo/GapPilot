import assert from 'node:assert/strict';
import test from 'node:test';
import { extractArticleFromHtml, isAllowedByRobots, normalizeCompetitorUrl } from '../lib/siteResearch.js';

test('normalizes a bare competitor domain to HTTPS', () => {
  assert.equal(normalizeCompetitorUrl('example.com/blog'), 'https://example.com/blog');
});

test('rejects local and non-HTTP competitor URLs', () => {
  assert.throws(() => normalizeCompetitorUrl('http://localhost:3000'), /public host/);
  assert.throws(() => normalizeCompetitorUrl('http://192.168.1.1'), /public host/);
  assert.throws(() => normalizeCompetitorUrl('file:///etc/passwd'), /public HTTP\(S\)/);
});

test('respects robots disallow rules and more-specific allow rules', () => {
  const rules = 'User-agent: *\nDisallow: /private\nAllow: /private/public\n';
  assert.equal(isAllowedByRobots(rules, 'https://example.com/private/post'), false);
  assert.equal(isAllowedByRobots(rules, 'https://example.com/private/public/post'), true);
  assert.equal(isAllowedByRobots('User-agent: *\nDisallow: /\nUser-agent: GapPilot\nAllow: /', 'https://example.com/blog/post'), true);
});

test('extracts readable article text and published date from HTML', () => {
  const paragraphs = Array.from({ length: 8 }, (_, index) =>
    `<p>Section ${index + 1}: Practical guidance for readers. ${'Useful original explanation. '.repeat(12)}</p>`,
  ).join('');
  const html = `<html><head><title>Page title</title><meta property="article:published_time" content="2026-11-20T10:00:00Z"><meta property="og:type" content="article"></head><body><article><h1>Readable article title</h1>${paragraphs}</article></body></html>`;
  const result = extractArticleFromHtml(html, 'https://example.com/blog/post');
  assert.equal(result.isArticle, true);
  assert.equal(result.article.title, 'Readable article title');
  assert.match(result.article.text, /Practical guidance/);
  assert.equal(result.article.publishedAt, '2026-11-20T10:00:00.000Z');
  assert.equal(result.article.isReadable, true);
});

test('rejects navigation pages that readability mistakes for articles', () => {
  const paragraphs = Array.from({ length: 5 }, () =>
    `<p>${'Navigation links and menu options. '.repeat(15)}</p>`,
  ).join('');
  const html = `<html><head><title>Main menu</title><meta property="og:type" content="article"></head><body><article><h1>Main menu</h1>${paragraphs}</article></body></html>`;
  const result = extractArticleFromHtml(html, 'https://example.com/2026/11/post');
  assert.equal(result.isArticle, true);
  assert.equal(result.article.isReadable, false);
});
