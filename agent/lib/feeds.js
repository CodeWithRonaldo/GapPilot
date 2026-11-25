// MONITOR stage: read RSS/Atom feeds (remote URLs or local fixture files).
import { readFile } from 'node:fs/promises';
import { XMLParser } from 'fast-xml-parser';
import { cleanText, findInjection, safeUrl } from './sanitize.js';

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
const asArray = (value) => (value == null ? [] : Array.isArray(value) ? value : [value]);
const textOf = (value) => (value && typeof value === 'object' ? value['#text'] ?? '' : value ?? '');

async function fetchText(source, { mock }) {
  if (!/^https?:\/\//.test(source)) {
    let xml = await readFile(new URL(`../${source}`, import.meta.url), 'utf8');
    // Fixtures use {{DAYS_AGO:n}} so the sample data never goes stale.
    if (mock) xml = xml.replace(/\{\{DAYS_AGO:(\d+)\}\}/g, (_, n) => new Date(Date.now() - n * 86400000).toUTCString());
    return xml;
  }
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(source, {
        headers: { 'User-Agent': 'GapPilot/0.1 (RSS reader)' },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw lastError;
}

function parseFeed(xml) {
  const doc = parser.parse(xml);
  if (doc.rss) {
    return asArray(doc.rss.channel?.item).map((item) => ({
      title: textOf(item.title),
      link: textOf(item.link),
      summary: textOf(item.description) || textOf(item['content:encoded']),
      date: textOf(item.pubDate),
    }));
  }
  if (doc.feed) {
    return asArray(doc.feed.entry).map((entry) => {
      const links = asArray(entry.link);
      const link = links.find((l) => !l['@_rel'] || l['@_rel'] === 'alternate') ?? links[0];
      return {
        title: textOf(entry.title),
        link: link?.['@_href'] ?? textOf(link),
        summary: textOf(entry.summary) || textOf(entry.content),
        date: textOf(entry.published) || textOf(entry.updated),
      };
    });
  }
  throw new Error('Not an RSS or Atom feed');
}

/** Returns { items, rejected } with every item sanitized. Never throws. */
export async function readFeed(name, source, { mock, limit }) {
  try {
    const raw = parseFeed(await fetchText(source, { mock })).slice(0, limit);
    const items = [];
    const rejected = [];
    for (const item of raw) {
      const clean = {
        source: name,
        title: cleanText(item.title, 200),
        link: safeUrl(item.link),
        summary: cleanText(item.summary, 600),
        date: item.date ? new Date(item.date).toISOString() : null,
      };
      const injection = findInjection(`${clean.title} ${clean.summary}`);
      if (injection) rejected.push({ ...clean, reason: `Possible prompt injection (${injection})` });
      else if (!clean.title) rejected.push({ ...clean, reason: 'Empty title' });
      else items.push(clean);
    }
    return { ok: true, items, rejected };
  } catch (error) {
    return { ok: false, items: [], rejected: [], error: error.message };
  }
}
