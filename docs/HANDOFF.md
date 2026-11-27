# GapPilot: Project Handoff

Status as of **2026-11-25**. Read this first, then the [README](../README.md) for usage.

## 1. What GapPilot is

An unattended AI content agent for a coding blog on Dev.to. On each run it:

1. reads competitor RSS feeds,
2. finds topics the blog hasn't covered yet,
3. scores them and **stays silent** if nothing is good enough,
4. writes an original post on the best topic,
5. **fact-checks it with Google Search**, and
6. publishes it to Dev.to live, but only if every safety rule passes. Otherwise it saves a draft.

Competitor posts are used **only as topic signals**. Their content is never copied.

**Stack:** Node.js 24 (agent, plain ESM, one dependency: `fast-xml-parser`), React 19 + Vite + CSS Modules (dashboard), Groq API (LLM, default) or Gemini API (switchable), Dev.to API (publishing). No database: state and traces are JSON files.

## 2. Current status at a glance

| Area | Status |
|---|---|
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

## 3. How a run works

```
TRIGGER → MONITOR → SCORE & DECIDE → WRITE → VERIFY → FACT-CHECK (→ REVISE → FACT-CHECK) → DECIDE → PUBLISH → TRACE
```

| Stage | What happens | Code |
|---|---|---|
| Trigger | Manual run; kill switch checked; missing API keys fail fast before any LLM spend | `agent/run.js` |
| Monitor | Reads competitor feeds + the blog's own feed. Every item is sanitized; injection-like items are rejected and logged | `agent/lib/feeds.js`, `agent/lib/sanitize.js` |
| Prefilter (no LLM) | Drops duplicates, already-drafted topics, items > 14 days old, and topics overlapping the blog's own posts | `agent/lib/score.js` → `prefilter` |
| Score | One LLM call rates all candidates (relevance, gap, info gain). **Final score and threshold are computed in code**, with freshness computed from the date | `agent/lib/score.js` → `scoreCandidates` |
| Write | LLM writes title, meta, tags, Markdown body, FAQ | `agent/lib/write.js` → `writeDraft` |
| Verify | Code checks: length, ≥ 3 headings, FAQ, meta length (auto-trimmed), links only to own posts or trusted docs domains, no injection text | `agent/lib/write.js` → `verifyDraft` |
| Fact-check | LLM with **Google Search** lists every claim, searches, and marks it confirmed/wrong/unverified. Retries once if it ran no searches | `agent/lib/review.js` → `reviewDraft` |
| Revise | One round if critical/major issues; also search-grounded; keeps original text when the reviewer was wrong | `agent/lib/review.js` → `reviseDraft` |
| Decide | **Deterministic rules in code** pick live vs draft (see §5) | `agent/lib/review.js` → `decidePublish` |
| Publish | The only module with write credentials. Adds an AI-assistance disclosure | `agent/lib/publisher.js` |
| Trace | Every run writes `data/traces/<id>.json` + `.md`: sources, scores, skips, LLM calls, searches, review, decision | `agent/lib/trace.js` |

**Run outcomes:** `published`, `drafted`, `no_opportunity` (stayed silent), `blocked` (quality gate / caps), `killed`, `error`.

## 4. File map

```
agent/
  run.js            Pipeline orchestration (start here)
  unpublish.js      Rollback: live post → draft
  config.json       All tunable settings (see §6)
  fixtures/         Sample feeds for mock mode (incl. 2 hostile items)
  lib/
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

## 5. Safety rules (all enforced in code)

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

| Key | Current | Meaning |
|---|---|---|
| `niche`, `audience`, `keywords` | Web dev (JS/React/CSS), beginner–intermediate | Steers scoring and writing |
| `myBlogFeed` | The project's Dev.to feed | Used to avoid duplicate topics |
| `competitorFeeds` | CSS-Tricks, Smashing, web.dev, freeCodeCamp, DEV #javascript | All verified working |
| `scoreThreshold` | 75 | Minimum score to write a post at all |
| `autoPublishMinScore` | 85 | Minimum topic score to go live |
| `minAccuracyScore` | 85 | Minimum fact-check accuracy to go live |
| `publishMode` | `"auto"` | `"draft"` = never publish live |
| `provider` | `"groq"` | `"groq"` or `"gemini"` |
| `models.groq` | score/write: `openai/gpt-oss-20b`; review/revise: `openai/gpt-oss-120b` (with `browser_search`) | Per-step models; each Groq model has its own daily token budget |
| `models.gemini` | score: `gemini-3.1-flash-lite`; write/review/revise: `gemini-2.5-flash` | Used when provider is `"gemini"` |
| `trustedLinkDomains` | MDN, caniuse, web.dev, react.dev, nodejs.org, … | Only external links allowed in posts |
| `maxPostsPerRun` / `PerWeek` / `maxLivePostsPerDay` / `maxLlmCallsPerRun` | 1 / 3 / 1 / 8 | Hard caps |

Thresholds were lowered from 80/90 to 75/85 because the lite scoring model scores about 10 points lower than 2.5 Flash for the same topic.

## 7. Known issues & limitations (read before continuing)

1. **Groq free-tier limits (current provider).**
   - Per model: **1,000 requests/day, 8,000 tokens/minute, 200,000 tokens/day**. Each model has its own budget, which is why score/write use `gpt-oss-20b` and review/revise use `gpt-oss-120b`.
   - **The fact-check is token-heavy:** `browser_search` reads web pages. One unrestricted review used about 195k of the 120b model's 200k daily tokens. The prompt now caps browsing (≤ 5 searches, ≤ 2 opened pages); **the real per-review token cost after that cap has not been measured yet**.
   - Output budgets (`maxTokens`) are set per step in code: score 3,000, write 6,000, review 4,000, revise 4,500. They must stay under the 8k/minute limit (Groq counts prompt + max output up front). The default budget was too small and cut articles off.
   - Not available on this account: `llama-3.3-70b-versatile`, `groq/compound`. Check with `GET https://api.groq.com/openai/v1/models`.
   - Per-minute limits are handled automatically (wait and retry). Daily limits stop the run with a clear message.
2. **Articles are generated as plain text, not JSON.** Long Markdown inside JSON kept breaking (`gpt-oss-20b` failed JSON validation 3×). The writer and reviser reply in a `TITLE / META / TAGS / ---BODY---` format parsed by `parsePost` in `write.js`. Short answers (scores, reviews) are still JSON.
3. **The fact-checker depends on web search.** Without search, models rejected correct modern CSS from outdated memory. The model decides by itself whether to search. Mitigated by the "list claims" prompt plus one retry plus the "no searches = no live post" rule.
4. **Gemini (kept as fallback provider):** free tier is 20 requests/day per project for `gemini-2.5-flash`; new projects can't use 2.5 Flash; `gemini-3.8-flash` was too slow; search grounding hit 429 on a newer project. Quotas are per project, not per key; don't create extra projects to dodge limits.
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
| Groq (switched from Gemini on 2026-11-26) | Gemini free tier was too restrictive (§7); Groq is fast with 1,000 requests/day. Gemini kept as a fallback provider |
| Search-grounded fact-check | Model-only review was confidently wrong on recent web features |
| Auto-publish requested by owner | Allowed only behind the strict rules in §5; falls back to drafts |
| JSON files instead of a database | Simplest thing that works for one site |

## 9. How to run

```bash
npm install
cp .env.example .env        # add GROQ_API_KEY and DEVTO_API_KEY
npm run agent:mock          # full pipeline on sample data, no keys, nothing posted
npm run agent               # real run (may publish live: see §5)
npm run dev                 # dashboard at http://localhost:5173
npm run unpublish           # turn the latest live post back into a draft
npm run lint
```

To stop everything immediately: set `KILL_SWITCH=true` in `.env`.
To never publish live: set `"publishMode": "draft"` in `agent/config.json`.

## 10. Where to continue (priority order)

1. **Make the first commit** (all files are staged; `.env` and `data/` are git-ignored).
2. **Complete one full live run on Groq** (after the 120b daily token budget recovers) and verify every stage in the trace, especially the search fact-check, the revision round, and live publish + `npm run unpublish`.
3. **Read every live post during the first week.** If the reviewer misses an error, tighten `review.js` prompts or rules.
4. **Daily schedule:** Windows Task Scheduler (simplest, state stays local) or GitHub Actions (needs repo secrets and persisted `data/state.json`).
5. **"Review only live candidates" optimization:** skip the fact-check when the topic score can only produce a draft anyway, which saves quota. Discussed, not built.
6. **Voice matching:** feed 3–5 of the owner's own posts into the writing prompt.
7. **Automated tests:** unit tests for `sanitize`, `prefilter`, `verifyDraft`, `decidePublish`; a hostile-input test pack for `feeds.js`.
8. **Config validation:** clear errors for typos or missing keys in `config.json`.
9. **Notifications:** email/Telegram message after each live post, with the unpublish command.
10. **More publishers:** Blogger, GitHub Pages (PR-based review), via the same `createPost` / `unpublish` interface in `publisher.js`.
11. **Production dashboard:** serve traces from a small API, or write a static `runs.json` at the end of each run.

## 11. Hackathon note (Agentware, Nov 27–30, 2026)

The Agentware rules require **all code to be written during the 72-hour event**, and code committed before kickoff disqualifies a submission. **This repo cannot be submitted** to that hackathon, not even copied into a new repo. If the team enters, start a fresh repo at kickoff and rebuild using this project only as a design reference. Planning before kickoff is allowed.
