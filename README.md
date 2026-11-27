# GapPilot

GapPilot is a terminal-first research and article-drafting agent. It asks for a blog niche, audience, and competitor website URLs; finds recent public articles; researches reader needs; and prints an original, SEO-focused draft only after quality checks pass. The terminal workflow does not publish to a blogging platform.

## Run the terminal agent

```bash
npm install
npx playwright install chromium
```

The Chromium download enables JavaScript-rendered article fallback. Static RSS and HTML extraction can work without launching it, but sites that require JavaScript will not be fully readable if the browser has not been installed.

Add one or more model API keys to `.env`. The terminal agent tries Claude (`claude-sonnet-4-5`) first, then Groq (`openai/gpt-oss-120b`, followed by `openai/gpt-oss-20b`), then Gemini. Providers without a configured key are skipped; a provider failure also advances to the next provider.

```dotenv
ANTHROPIC_API_KEY=your-key
GROQ_API_KEY=your-key
GEMINI_API_KEY=your-key
```

Then run:

```bash
npm run agent
```

The agent prompts only for the niche, audience, and competitor website URLs. It logs progress, findings, search queries, and quality checks to the terminal. The final Markdown article is written to standard output; progress messages go to standard error.

The agent uses RSS/Atom feeds and sitemaps where available, extracts article text from public pages, and falls back to a headless browser for JavaScript-rendered article pages. It analyzes competitor content only to create a research brief; the writing step receives the brief, not the competitor's full article.

## Terminal workflow

1. Validate user input and find recent articles on the supplied competitor sites.
2. Select the newest successfully extracted article across the supplied competitor sites.
3. Research search intent, reader questions, factual claims, and content gaps.
4. Draft an original article from the research brief.
5. Check article structure, word count, SEO fields, keyword placement, factual accuracy, and phrase overlap.
6. Revise once if needed. Print the article only if it passes the checks and search-grounded review.

If a site cannot be accessed or its article text cannot be extracted, the agent reports the failure and continues with the other supplied sites. If no articles can be researched or the draft fails its quality gates, it exits without printing an article.

## Developer tools

```bash
npm test             # focused agent tests
npm run lint
npm run agent:mock   # legacy pipeline plumbing test; not a real research run
npm run dev           # existing dashboard (not required by the terminal agent)
```

`agent:mock` uses sample feeds and a fake model response to test the older pipeline; it does not demonstrate real competitor research or article quality. `agent/run.js` and its Dev.to publisher are retained separately from the terminal-first `npm run agent` workflow.

## Scope and safeguards

- The terminal agent produces text only; it does not publish or connect to Blogger, Tumblr, GitHub Pages, or Dev.to.
- Competitor article content is treated as untrusted input and used to derive a brief, not as prose or an outline to imitate.
- Fetches are limited to public HTTP(S) pages on the supplied competitor site, follow robots.txt rules, and use response-size and timeout limits.
- Search results are used to verify claims and research reader needs; the model must run searches during quality review.
- Add only API keys you trust to `.env`; do not commit that file.
