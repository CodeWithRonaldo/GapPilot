import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Readability } from '@mozilla/readability';
import { XMLParser } from 'fast-xml-parser';
import { JSDOM } from 'jsdom';
import { chromium } from 'playwright';
import { cleanText, findInjection } from './sanitize.js';

const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_ARTICLE_CHARS = 16000;
const MIN_ARTICLE_CHARS = 500;
const dnsCache = new Map();
const asArray = (value) => (value == null ? [] : Array.isArray(value) ? value : [value]);
const textOf = (value) => (value && typeof value === 'object' ? value['#text'] ?? '' : value ?? '');

function isPrivateIp(address) {
  const version = isIP(address);
  if (version === 4) {
    const [a, b] = address.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (version === 6) {
    const ip = address.toLowerCase();
    if (ip.startsWith('::ffff:')) return isPrivateIp(ip.slice(7));
    return ip === '::' || ip === '::1' || ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('fe8')
      || ip.startsWith('fe9') || ip.startsWith('fea') || ip.startsWith('feb');
  }
  return true;
}

async function assertPublicHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal'))
    throw new Error(`Refusing local or private host: ${hostname}`);
  if (isIP(host)) {
    if (isPrivateIp(host)) throw new Error(`Refusing local or private IP: ${hostname}`);
    return;
  }
  let addresses = dnsCache.get(host);
  if (!addresses) {
    addresses = (await lookup(host, { all: true })).map((entry) => entry.address);
    dnsCache.set(host, addresses);
  }
  if (!addresses.length || addresses.some(isPrivateIp)) throw new Error(`Host does not resolve exclusively to public IPs: ${hostname}`);
}

async function assertPublicUrl(value) {
  const url = value instanceof URL ? value : normalizeUrl(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`Refusing non-HTTP resource URL: ${url.href}`);
  await assertPublicHost(url.hostname);
  return url;
}

function normalizeUrl(value) {
  const raw = String(value ?? '').trim();
  const withProtocol = /^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url;
  try {
    url = new URL(withProtocol);
  } catch {
    throw new Error(`Invalid website URL: ${raw}`);
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error(`Only public HTTP(S) website URLs are supported: ${raw}`);
  url.hash = '';
  return url;
}

function belongsToSite(url, siteHost) {
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const site = siteHost.toLowerCase().replace(/^www\./, '');
  return host === site || host.endsWith(`.${site}`) || site.endsWith(`.${host}`);
}

async function assertSiteUrl(value, siteHost) {
  const url = value instanceof URL ? value : normalizeUrl(value);
  if (!['http:', 'https:'].includes(url.protocol) || !belongsToSite(url, siteHost))
    throw new Error(`Refusing URL outside the competitor site: ${url.href}`);
  await assertPublicHost(url.hostname);
  return url;
}

async function readLimitedText(response, maxBytes) {
  const declaredSize = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredSize) && declaredSize > maxBytes) throw new Error(`Response exceeds ${maxBytes} byte limit`);
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`Response exceeds ${maxBytes} byte limit`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function fetchSiteText(value, siteHost, { maxBytes = MAX_RESPONSE_BYTES } = {}) {
  let url = await assertSiteUrl(value, siteHost);
  for (let redirects = 0; redirects <= 5; redirects++) {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'GapPilot/0.1 (public blog research)' },
      redirect: 'manual',
      signal: AbortSignal.timeout(20000),
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) throw new Error(`Redirect from ${url.href} has no location`);
      url = await assertSiteUrl(new URL(location, url), siteHost);
      continue;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url.href}`);
    return { text: await readLimitedText(response, maxBytes), url, contentType: response.headers.get('content-type') ?? '' };
  }
  throw new Error(`Too many redirects for ${url.href}`);
}

function decodeEntities(value) {
  return String(value ?? '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function parseAttributes(tag) {
  const attrs = {};
  for (const match of tag.matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g))
    attrs[match[1].toLowerCase()] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? '');
  return attrs;
}

function discoverFeedLinks(html, baseUrl) {
  const links = [];
  for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
    const attrs = parseAttributes(match[0]);
    if (/alternate/i.test(attrs.rel ?? '') && /rss|atom|xml/i.test(attrs.type ?? '') && attrs.href) {
      try {
        links.push(new URL(attrs.href, baseUrl).href);
      } catch {
        // Ignore malformed feed links.
      }
    }
  }
  for (const path of ['/feed/', '/feed.xml', '/rss.xml', '/atom.xml', '/rss', '/blog/feed/'])
    links.push(new URL(path, baseUrl.origin).href);
  return [...new Set(links)];
}

function parseFeed(xml) {
  const doc = xmlParser.parse(xml);
  if (doc.rss) {
    return asArray(doc.rss.channel?.item).map((item) => ({
      title: cleanText(textOf(item.title), 200),
      link: cleanText(textOf(item.link), 2048),
      date: textOf(item.pubDate) || textOf(item['dc:date']),
      content: textOf(item['content:encoded']) || textOf(item.description),
      hasFullContent: Boolean(textOf(item['content:encoded'])),
    }));
  }
  if (doc.feed) {
    return asArray(doc.feed.entry).map((entry) => {
      const links = asArray(entry.link);
      const link = links.find((item) => !item['@_rel'] || item['@_rel'] === 'alternate') ?? links[0];
      return {
        title: cleanText(textOf(entry.title), 200),
        link: link?.['@_href'] ?? textOf(link),
        date: textOf(entry.published) || textOf(entry.updated),
        content: textOf(entry.content) || textOf(entry.summary),
        hasFullContent: Boolean(textOf(entry.content)),
      };
    });
  }
  return [];
}

function parseDate(value) {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

export function isAllowedByRobots(robotsText, url) {
  const groups = [];
  let group = null;
  for (const rawLine of String(robotsText ?? '').split(/\r?\n/)) {
    const line = rawLine.split('#', 1)[0].trim();
    if (!line) continue;
    const separator = line.indexOf(':');
    if (separator < 0) continue;
    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (name === 'user-agent') {
      if (!group || group.hasRules) {
        group = { agents: [], rules: [], hasRules: false };
        groups.push(group);
      }
      group.agents.push(value.toLowerCase());
    } else if ((name === 'allow' || name === 'disallow') && group) {
      group.hasRules = true;
      if (value) group.rules.push({ allow: name === 'allow', path: value });
    }
  }

  const specific = groups.filter((item) => item.agents.some((agent) => agent !== '*' && agent.includes('gappilot')));
  const applicable = specific.length ? specific : groups.filter((item) => item.agents.includes('*'));
  const pathname = `${new URL(url).pathname}${new URL(url).search}`;
  const matches = applicable.flatMap((item) => item.rules).filter((rule) => {
    const pattern = rule.path
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\\\$$/, '$');
    return new RegExp(`^${pattern}`).test(pathname);
  }).sort((a, b) => b.path.replace(/[*$]/g, '').length - a.path.replace(/[*$]/g, '').length);
  return !matches.length || matches[0].allow;
}

async function loadRobots(siteUrl, siteHost, log) {
  const robotsUrl = new URL('/robots.txt', siteUrl.origin);
  try {
    const { text } = await fetchSiteText(robotsUrl, siteHost, { maxBytes: 200 * 1024 });
    log('Read the site robots.txt rules');
    return text;
  } catch (error) {
    if (/HTTP (404|410)\b/.test(error.message)) {
      log('No robots.txt file found; continuing with bounded requests');
      return '';
    }
    throw new Error(`Could not check the site's robots.txt rules: ${error.message}`, { cause: error });
  }
}

function extractArticle(html, url) {
  const dom = new JSDOM(html, { url: url.href });
  try {
    const { document } = dom.window;
    const publishedAt = parseDate(
      document.querySelector('meta[property="article:published_time"]')?.content
      || document.querySelector('meta[name="date"], meta[name="pubdate"], time[datetime]')?.content
      || document.querySelector('time[datetime]')?.getAttribute('datetime'),
    );
    const ogType = document.querySelector('meta[property="og:type"]')?.content ?? '';
    const structuredArticle = [...document.querySelectorAll('script[type="application/ld+json"]')]
      .some((script) => /article|blogposting/i.test(script.textContent ?? ''));
    const article = new Readability(document.cloneNode(true)).parse();
    if (!article) return { article: null, isArticle: /article/i.test(ogType) || structuredArticle };
    const content = cleanText(article.textContent, MAX_ARTICLE_CHARS);
    if (!content) return { article: null, isArticle: /article/i.test(ogType) || structuredArticle };
    const articleDom = new JSDOM(article.content);
    const articleDocument = articleDom.window.document;
    const articleTextLength = articleDocument.body.textContent?.trim().length ?? 0;
    const linkedTextLength = [...articleDocument.querySelectorAll('a')]
      .reduce((length, link) => length + (link.textContent?.trim().length ?? 0), 0);
    const paragraphCount = articleDocument.querySelectorAll('p').length;
    articleDom.window.close();
    const title = cleanText(document.querySelector('article h1, main h1, h1')?.textContent || article.title, 200);
    const genericTitle = /^(main menu|menu|home|homepage|index|latest posts?|latest news|untitled|404|page not found)$/i.test(title);
    const linkDensity = linkedTextLength / Math.max(1, articleTextLength);
    const readable = content.length >= MIN_ARTICLE_CHARS && !genericTitle && linkDensity < 0.4
      && (paragraphCount >= 2 || content.length >= 1000);
    return {
      isArticle: /article/i.test(ogType) || structuredArticle || looksLikeArticlePath(url.pathname),
      article: {
        title,
        excerpt: cleanText(article.excerpt, 500),
        text: content,
        publishedAt,
        url: url.href,
        isReadable: readable,
      },
    };
  } finally {
    dom.window.close();
  }
}

function candidateLinksFromHtml(html, baseUrl) {
  const links = [];
  for (const match of html.matchAll(/<a\b[^>]*>/gi)) {
    const href = parseAttributes(match[0]).href;
    if (!href) continue;
    try {
      const url = new URL(href, baseUrl);
      if (belongsToSite(url, baseUrl.hostname) && looksLikeArticlePath(url.pathname))
        links.push(url.href);
    } catch {
      // Ignore malformed navigation links.
    }
  }
  return [...new Set(links)].slice(0, 12);
}

function looksLikeArticlePath(pathname) {
  return /\/(blog|blogs|post|posts|article|articles|news|writing|p|entry)\/[^/]+/i.test(pathname)
    || /\/\d{4}\/\d{1,2}\/[^/]+\/?$/i.test(pathname)
    || /\/@[^/]+\/[^/]+\/?$/i.test(pathname);
}

async function sitemapCandidates(siteUrl, siteHost, isAllowed) {
  const maps = [new URL('/sitemap.xml', siteUrl.origin).href];
  const candidates = [];
  for (const mapUrl of maps) {
    try {
      if (!isAllowed(mapUrl)) continue;
      const { text } = await fetchSiteText(mapUrl, siteHost);
      const parsed = xmlParser.parse(text);
      let urls = asArray(parsed.urlset?.url);
      if (parsed.sitemapindex) {
        const children = asArray(parsed.sitemapindex.sitemap).slice(0, 2);
        for (const child of children) {
          const loc = textOf(child.loc);
          if (!loc || !isAllowed(loc)) continue;
          const childResult = await fetchSiteText(loc, siteHost);
          urls.push(...asArray(xmlParser.parse(childResult.text).urlset?.url));
        }
      }
      candidates.push(...urls.map((item) => ({
        link: textOf(item.loc),
        date: parseDate(textOf(item.lastmod)),
      })).filter((item) => item.link));
      break;
    } catch {
      // Sitemaps are optional; try page links if there isn't a usable one.
    }
  }
  return candidates;
}

async function renderWithJavaScript(url, siteHost) {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    await context.route('**/*', async (route) => {
      try {
        await assertPublicUrl(route.request().url());
        await route.continue();
      } catch {
        await route.abort();
      }
    });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    await assertSiteUrl(page.url(), siteHost);
    return await page.content();
  } finally {
    await browser.close();
  }
}

function rankCandidates(items) {
  return [...items].sort((a, b) => {
    const ta = a.date ? Date.parse(a.date) : -Infinity;
    const tb = b.date ? Date.parse(b.date) : -Infinity;
    return tb - ta || (a.order ?? 0) - (b.order ?? 0);
  });
}

export function normalizeCompetitorUrl(value) {
  const url = normalizeUrl(value);
  if (url.hostname === 'localhost' || url.hostname.endsWith('.localhost') || url.hostname.endsWith('.local')
    || url.hostname.endsWith('.internal') || (isIP(url.hostname) && isPrivateIp(url.hostname)))
    throw new Error(`Competitor URL must use a public host: ${url.hostname}`);
  return url.href;
}

export function extractArticleFromHtml(html, url) {
  const parsedUrl = normalizeUrl(url);
  return extractArticle(html, parsedUrl);
}

export async function findLatestArticle(inputUrl, { log = () => {} } = {}) {
  const siteUrl = normalizeUrl(inputUrl);
  await assertPublicHost(siteUrl.hostname);
  const siteHost = siteUrl.hostname;
  log(`Checking competitor site ${siteUrl.origin}`);

  const robotsText = await loadRobots(siteUrl, siteHost, log);
  const allowedByPolicy = (url) => isAllowedByRobots(robotsText, url);
  if (!allowedByPolicy(siteUrl.href)) throw new Error(`The supplied page is disallowed by ${siteUrl.origin}/robots.txt`);
  const homepage = await fetchSiteText(siteUrl, siteHost);
  log(`Fetched site page (${homepage.text.length.toLocaleString()} characters)`);
  const homepageArticle = extractArticle(homepage.text, homepage.url);
  if (homepageArticle.isArticle && homepageArticle.article?.isReadable) {
    const injection = findInjection(`${homepageArticle.article.title} ${homepageArticle.article.text}`);
    if (injection) throw new Error(`Article rejected due to possible prompt-injection content (${injection})`);
    log(`Input URL is an article: "${homepageArticle.article.title}"`);
    const article = { ...homepageArticle.article };
    delete article.isReadable;
    return article;
  }

  const candidates = [];
  const feedUrls = discoverFeedLinks(homepage.text, homepage.url);
  log('Looking for an RSS or Atom feed');
  for (const feedUrl of feedUrls) {
    if (!allowedByPolicy(feedUrl)) {
      log(`Skipping feed disallowed by robots.txt: ${feedUrl}`);
      continue;
    }
    log(`Checking feed ${feedUrl}`);
    try {
      const { text } = await fetchSiteText(feedUrl, siteHost);
      const entries = parseFeed(text);
      if (entries.length) {
        log(`Found ${entries.length} entries in feed ${feedUrl}`);
        candidates.push(...entries.map((entry, order) => ({
          ...entry,
          date: parseDate(entry.date),
          order,
          discovery: 'feed',
        })));
        break;
      }
      log(`No feed entries found at ${feedUrl}`);
    } catch (error) {
      log(`Feed unavailable at ${feedUrl}: ${error.message}`);
    }
  }

  if (!candidates.length) {
    log('No usable feed found; checking the sitemap');
    const sitemap = await sitemapCandidates(homepage.url, siteHost, allowedByPolicy);
    candidates.push(...sitemap
      .filter((entry) => {
        try {
          return looksLikeArticlePath(new URL(entry.link).pathname);
        } catch {
          return false;
        }
      })
      .map((entry, order) => ({ ...entry, order, discovery: 'sitemap' })));
    if (candidates.length) log(`Found ${candidates.length} likely article URLs in the sitemap`);
  }

  if (!candidates.length) {
    const links = candidateLinksFromHtml(homepage.text, homepage.url);
    candidates.push(...links.map((link, order) => ({ link, date: null, order, discovery: 'homepage' })));
    if (candidates.length) log(`Found ${candidates.length} likely article links on the homepage`);
  }
  if (!candidates.length) throw new Error(`No RSS feed, sitemap article, or article links found for ${siteUrl.origin}`);

  const ranked = rankCandidates(candidates.filter((item) => item.link)).slice(0, 5);
  const extracted = [];
  for (const candidate of ranked) {
    let url;
    try {
      url = await assertSiteUrl(candidate.link, siteHost);
      if (!allowedByPolicy(url.href)) {
        log(`Skipping article disallowed by robots.txt: ${url.href}`);
        continue;
      }
      log(`Inspecting ${url.href}`);
      const page = await fetchSiteText(url, siteHost);
      let result = extractArticle(page.text, page.url);
      if ((!result.article || !result.article.isReadable) && result.isArticle) {
        log('Static HTML did not expose enough article text; trying headless JavaScript rendering');
        const rendered = await renderWithJavaScript(page.url.href, siteHost);
        result = extractArticle(rendered, page.url);
      }
      if ((!result.article || !result.article.isReadable) && candidate.hasFullContent && candidate.content) {
        const fallback = extractArticle(candidate.content, page.url);
        if (fallback.article?.isReadable)
          result = { ...fallback, article: { ...fallback.article, title: fallback.article.title || candidate.title } };
        else {
          const feedText = cleanText(candidate.content, MAX_ARTICLE_CHARS);
          if (feedText.length >= MIN_ARTICLE_CHARS) {
            result = {
              isArticle: true,
              article: {
                title: candidate.title,
                text: feedText,
                excerpt: '',
                publishedAt: null,
                url: page.url.href,
                isReadable: true,
              },
            };
          }
        }
      }
      if (!result.article?.isReadable) {
        log(`Skipped ${url.href}: extracted page did not look like a readable article body`);
        continue;
      }
      const articleData = { ...result.article };
      delete articleData.isReadable;
      const article = {
        ...articleData,
        title: articleData.title || candidate.title,
        publishedAt: articleData.publishedAt ?? candidate.date ?? null,
        url: page.url.href,
        source: siteUrl.origin,
        discovery: candidate.discovery,
      };
      const injection = findInjection(`${article.title} ${article.text}`);
      if (injection) {
        log(`Rejected ${url.href}: possible prompt-injection content (${injection})`);
        continue;
      }
      extracted.push({ article, order: candidate.order });
      log(`Extracted "${article.title}" (${article.text.length.toLocaleString()} characters)`);
    } catch (error) {
      log(`Could not extract ${candidate.link}: ${error.message}`);
    }
  }
  if (!extracted.length) throw new Error(`Could not extract a full article from ${siteUrl.origin}`);
  extracted.sort((a, b) => {
    const ta = a.article.publishedAt ? Date.parse(a.article.publishedAt) : -Infinity;
    const tb = b.article.publishedAt ? Date.parse(b.article.publishedAt) : -Infinity;
    return tb - ta || a.order - b.order;
  });
  const latest = extracted[0].article;
  log(`Selected latest extractable article: "${latest.title}"${latest.publishedAt ? ` (${latest.publishedAt.slice(0, 10)})` : ' (publication date unavailable)'}`);
  return latest;
}
