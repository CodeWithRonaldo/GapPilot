# GapPilot: Project Handoff

Status as of **2026-11-27**. Read the [README](../README.md) for current terminal-agent usage. Sections about Dev.to publishing describe the retained legacy pipeline, not the default command.

## 1. What GapPilot is

The default `npm run agent` is a terminal-only research and drafting workflow. It asks for the user's niche, audience, and competitor website URLs; discovers recent articles; creates a research brief; writes an original post; and prints Markdown only after structural, SEO, originality, and search-grounded quality checks pass. It does not publish.

Competitor articles are research inputs, not templates. The full extracted text is used to understand reader needs and create a brief; the writing step receives the brief rather than the competitor text.

**Stack:** Node.js 24, Claude/Groq/Gemini APIs, RSS/XML parsing, Mozilla Readability + jsdom for static pages, and Playwright Chromium as a JavaScript-rendering fallback. The React/Vite dashboard and the old Dev.to publishing pipeline remain separate from the terminal workflow.

## 2. Current status at a glance

| Area | Status |
|---|---|
| Terminal input, competitor discovery, research brief, writing, and quality gates | ✅ Implemented; needs a real end-to-end run with user inputs and an LLM key |
| Public article extraction (RSS/sitemap/static HTML/headless fallback) | ✅ Implemented; broad site coverage still needs live testing |
| Terminal workflow publishing | Not implemented by design; it prints Markdown only |
| Focused automated tests | ✅ Added for extraction, originality checks, SEO checks, and writer input boundaries |
| Feed monitoring (5 real feeds) | ✅ Working, tested live |
| Prompt-injection / HTML sanitizing | ✅ Working, tested with hostile sample items |
| Topic scoring (Groq/Gemini, JSON mode) | ✅ Working, tested live |
| Draft writing + format checks | ✅ Working, tested live (drafts of 629–1,626 words passed) |
| Dev.to draft creation | ✅ Working: 2 real drafts created on the project's account |
| Search-based fact-check | ✅ Works in isolated tests (catches false claims, confirms true ones). ⚠️ **Not yet completed on a full live run**: blocked by quota (see §7) |
| Revision round after a failed review | ⚠️ Ran once *before* search was added (made the draft worse). Not yet run with search |
| Live publishing to Dev.to | ⚠️ Code tested in mock mode only. **No post has been published live yet** |
| `npm run unpublish` rollback | ⚠️ Tested with "nothing to unpublish" only |
| Dashboard | ✅ Working (dev server only) |
| Daily schedule | ❌ Not built |
| Automated tests | ❌ None, only manual and mock runs |
| Git | ⚠️ Everything staged, **first commit pending** |

## 3. Current terminal workflow

```
PROMPT → DISCOVER → EXTRACT → SCORE → RESEARCH BRIEF → WRITE → CHECK → REVIEW → (REVISE → RECHECK) → PRINT
```

| Stage | What happens | Code |
|---|---|---|
| Prompt | Collect niche, audience, competitor URLs, optional region/keywords/voice; check provider key | `agent/cli.js` |
| Discover and extract | Check feeds, sitemaps, and page links; extract static HTML and use headless Chromium when needed | `agent/lib/siteResearch.js` |
| Score | Rank latest extractable articles for the supplied niche and audience | `agent/lib/score.js` |
| Research | Search for intent, reader questions, claims, gaps, and an independent angle; log findings | `agent/lib/terminalContent.js`, `agent/lib/llm.js` |
| Write | Generate from the research brief; competitor full text is not sent to the writer | `agent/lib/terminalContent.js` |
| Check and review | Verify structure, length, SEO fields, keyword placement, phrase overlap, claims, and quality scores; allow one revision | `agent/lib/terminalContent.js`, `agent/lib/write.js` |
| Print | Progress goes to stderr; final Markdown goes to stdout only after all gates pass | `agent/cli.js` |

## 4. File map

```
agent/
  cli.js            Default interactive terminal workflow (start here)
  run.js            Retained legacy feed/Dev.to pipeline
  unpublish.js      Rollback: live post → draft
  config.json       All tunable settings (see §6)
  fixtures/         Sample feeds for mock mode (incl. 2 hostile items)
  lib/
    siteResearch.js RSS/sitemap/site-link discovery, article extraction, headless fallback
    terminalContent.js Research brief, brief-based writing, SEO/originality gates, review
    feeds.js        RSS/Atom fetch + parse (timeout, 1 retry)
    sanitize.js     HTML/invisible-char stripping, injection patterns
    score.js        Prefilter + LLM scoring
    write.js        Drafting, verification, saving rejected drafts
    review.js       Fact-check, revision, publish decision
    llm.js          LLM client: Groq + Gemini providers, JSON/text/search modes, token budgets, rate-limit handling
    publisher.js    Dev.to + mock publishers (create / unpublish)
    guards.js       Kill switch, state file, rate caps
    trace.js        Audit trail writer
src/                Dashboard (React + CSS Modules), reads /api/runs
vite.config.js      Dev-server middleware serving data/traces as /api/runs
data/               (git-ignored) traces/, state.json, state-mock.json, drafts/, rejected/
.env                (git-ignored) API keys; template in .env.example
```

## 5. Legacy Dev.to pipeline safety rules

The rules in this section apply to `agent/run.js`, not the default terminal workflow.

- **Kill switch:** `KILL_SWITCH=true` in `.env`, or create the file `agent/KILL_SWITCH`. Checked at the start and right before publishing.
- **Live publishing only if ALL of these pass**, otherwise it becomes a Dev.to draft:
  - `publishMode` is `"auto"`
  - topic score ≥ `autoPublishMinScore` (85)
  - reviewer verdict is `approve`, with **0 critical and 0 major** issues
  - accuracy ≥ `minAccuracyScore` (85)
  - the reviewer **actually ran Google searches** (added after it once approved a post at "100%" without checking anything)
  - fewer than `maxLivePostsPerDay` (1) live posts in the last 24 h
- **Critical issues left after revision:** the post is not sent anywhere; it's saved to `data/rejected/`.
- **Claims the reviewer marks wrong or unverified** are forced into the issue list in code, even if the model omits them.
- **Caps:** 1 post per run, 3 per week, 8 LLM calls per run.
- **No double posts:** drafted/published topics are stored in `data/state.json` immediately. A corrupted state file **stops** the run rather than resetting.
- **Mock runs** use a separate `data/state-mock.json`, so tests never count toward real caps.
- **Untrusted input:** feed text is data only. Prompts wrap it in markers and say never to follow instructions inside it.
- **Disclosure:** every post ends with an AI-assistance and AI-fact-check note (Dev.to expects disclosure).

## 6. Configuration (`agent/config.json`)

The terminal workflow collects only niche, audience, and competitor sites at run time. It does not read `agent/config.json`. It tries Claude, Groq, then Gemini, skipping providers without an API key; it uses internal run limits.

| Key | Current | Meaning |
|---|---|---|
| `niche`, `audience`, `keywords` | Web dev (JS/React/CSS), beginner–intermediate | Steers scoring and writing |
| `myBlogFeed` | The project's Dev.to feed | Used to avoid duplicate topics |
| `competitorFeeds` | CSS-Tricks, Smashing, web.dev, freeCodeCamp, DEV #javascript | All verified working |
| `scoreThreshold` | 75 | Minimum score to write a post at all |
| `autoPublishMinScore` | 85 | Minimum topic score to go live |
| `minAccuracyScore` | 85 | Minimum fact-check accuracy to go live |
| `publishMode` | `"auto"` | `"draft"` = never publish live |
| `provider` | `"claude"` | Primary provider for the legacy pipeline |
| `fallbackProviders` | `["groq", "gemini"]` | Ordered fallback providers for the legacy pipeline |
| `models.claude` | `claude-sonnet-4-5` for each step | Primary model for the legacy pipeline |
| `models.groq` | score/write: `openai/gpt-oss-20b`; review/revise: `openai/gpt-oss-120b` (with `browser_search`) | Per-step models; each Groq model has its own daily token budget |
| `models.gemini` | score: `gemini-3.1-flash-lite`; write/review/revise: `gemini-2.5-flash` | Used when provider is `"gemini"` |
| `trustedLinkDomains` | MDN, caniuse, web.dev, react.dev, nodejs.org, … | Only external links allowed in posts |
| `maxPostsPerRun` / `PerWeek` / `maxLivePostsPerDay` / `maxLlmCallsPerRun` | 1 / 3 / 1 / 8 | Hard caps |

Thresholds were lowered from 80/90 to 75/85 because the lite scoring model scores about 10 points lower than 2.5 Flash for the same topic.

## 7. Known issues & limitations (read before continuing)

1. **Groq free-tier limits (first fallback).**
   - Per model: **1,000 requests/day, 8,000 tokens/minute, 200,000 tokens/day**. Each model has its own budget, which is why score/write use `gpt-oss-20b` and review/revise use `gpt-oss-120b`.
   - **The fact-check is token-heavy:** `browser_search` reads web pages. One unrestricted review used about 195k of the 120b model's 200k daily tokens. The prompt now caps browsing (≤ 5 searches, ≤ 2 opened pages); **the real per-review token cost after that cap has not been measured yet**.
   - Output budgets (`maxTokens`) are set per step in code: score 3,000, write 6,000, review 4,000, revise 4,500. They must stay under the 8k/minute limit (Groq counts prompt + max output up front). The default budget was too small and cut articles off.
   - Not available on this account: `llama-3.3-70b-versatile`, `groq/compound`. Check with `GET https://api.groq.com/openai/v1/models`.
   - Per-minute limits are handled automatically (wait and retry). Daily limits stop the run with a clear message.
2. **Articles are generated as plain text, not JSON.** Long Markdown inside JSON kept breaking (`gpt-oss-20b` failed JSON validation 3×). The writer and reviser reply in a `TITLE / META / TAGS / ---BODY---` format parsed by `parsePost` in `write.js`. Short answers (scores, reviews) are still JSON.
3. **The fact-checker depends on web search.** Without search, models rejected correct modern CSS from outdated memory. The model decides by itself whether to search. Mitigated by the "list claims" prompt plus one retry plus the "no searches = no live post" rule.
4. **Gemini (last fallback):** free tier is 20 requests/day per project for `gemini-2.5-flash`; new projects can't use 2.5 Flash; `gemini-3.8-flash` was too slow; search grounding hit 429 on a newer project. Quotas are per project, not per key; don't create extra projects to dodge limits.
5. **No live publish has happened yet**, so the full live path (review → decide → publish live → unpublish) still needs one end-to-end verification.
6. **Dashboard works only with `npm run dev`.** `/api/runs` is Vite dev-server middleware, so a production build has no data source.
7. **State is local.** `data/state.json` lives on one machine. Any cloud scheduler must persist it, or the duplicate and cap protection is lost.
8. **Mock-mode scoring and writing are fake** (keyword counting, template text). Mock mode tests the plumbing, not quality.
9. **No automated test suite.** Everything was verified with manual runs and scripted one-off checks.
10. **Blog has few posts**, so duplicate detection has little to compare against. It improves as posts are added.

## 8. Decisions & why

| Decision | Why |
|---|---|
| Competitors as topic signals only | Copying/rewriting risks copyright, Google spam penalties, and Dev.to bans |
| Final score, thresholds and publish decision in code, not the LLM | Predictable, auditable; the LLM can't talk its way into publishing |
| Dev.to as the first platform | Free API, built-in audience, fits a coding blog |
| Claude → Groq → Gemini provider order | Claude is the preferred provider; Groq's two models are fallback before Gemini |
| Search-grounded fact-check | Model-only review was confidently wrong on recent web features |
| Auto-publish requested by owner | Allowed only behind the strict rules in §5; falls back to drafts |
| JSON files instead of a database | Simplest thing that works for one site |

## 9. How to run

```bash
npm install
npm run agent               # terminal workflow; requires at least one of ANTHROPIC_API_KEY, GROQ_API_KEY, GEMINI_API_KEY
npm test                    # focused agent tests
npm run lint
npm run agent:mock          # legacy pipeline plumbing test only; no real research
npm run dev                 # existing dashboard; not required by the terminal workflow
```

Run `npx playwright install chromium` after installing dependencies if Chromium is not already available. The terminal workflow does not use a publisher or require `DEVTO_API_KEY`.

## 10. Where to continue

1. Run `npm test` and `npm run lint`, then run `npm run agent` with a real niche, audience, public competitor URLs, and an LLM key; verify both successful extraction and fail-closed behavior.
2. Test varied publisher/CMS layouts, RSS variants, sitemap indexes, JavaScript-rendered pages, and missing publication dates.
3. Tune the research and quality gates based on real terminal runs without weakening the original-content boundary.
4. Later, add user profiles and publisher adapters for Blogger, Tumblr, and GitHub Pages. These are intentionally outside the current terminal-only milestone.

## 11. Hackathon note (Agentware, Nov 27–30, 2026)

The Agentware rules require **all code to be written during the 72-hour event**, and code committed before kickoff disqualifies a submission. **This repo cannot be submitted** to that hackathon, not even copied into a new repo. If the team enters, start a fresh repo at kickoff and rebuild using this project only as a design reference. Planning before kickoff is allowed.
