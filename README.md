# GapPilot

An unattended content agent for bloggers. It watches competitor RSS feeds, finds topics your blog
hasn't covered, scores them, and **only when a topic clears a strict bar** writes an original draft
and saves it as a **draft** on Dev.to. No real opportunity = no post.

Competitor posts are used only as *topic signals*. GapPilot never copies their content.

> **New to the project?** Read [docs/HANDOFF.md](docs/HANDOFF.md): current status, known issues, and where to continue.

## Quick start (no keys needed)

```bash
npm install
npm run agent:mock   # sample feeds + fake LLM, draft saved to data/drafts/
npm run dev          # dashboard at http://localhost:5173
```

## Live mode

1. `cp .env.example .env` and add:
   - `GROQ_API_KEY`: free at https://console.groq.com/keys (or `GEMINI_API_KEY` with `"provider": "gemini"` in config)
   - `DEVTO_API_KEY`: Dev.to > Settings > Extensions
2. Edit `agent/config.json`: your niche, keywords, your blog feed, and competitor feeds.
3. `npm run agent`

## How a run works

| Stage | File | What happens |
|---|---|---|
| Trigger | `agent/run.js` | Manual or scheduled run; kill switch checked |
| Monitor | `agent/lib/feeds.js` | Reads RSS/Atom feeds; every item sanitized (`sanitize.js`) |
| Score & decide | `agent/lib/score.js` | Drops duplicates and topics already on your blog; LLM rates the rest; final score computed in code; below threshold = stay silent |
| Create & verify | `agent/lib/write.js` | LLM drafts the post; code checks length, headings, FAQ, links, injection text |
| Gate & act | `agent/lib/publisher.js` | Kill switch re-checked, rate caps enforced, published live or as a draft (see rules below) |

Every run writes `data/traces/<run>.json` and `<run>.md`, which the dashboard displays.

## Safety (enforced in code)

- **Kill switch:** `KILL_SWITCH=true` in `.env`, or create the file `agent/KILL_SWITCH`. Checked at start and right before publishing.
- **Strict AI fact-check (switch: `"factCheck"` in config; currently OFF to save tokens):** a separate reviewer pass checks every claim, code sample, command and version, with one revision round. Posts with critical issues left are never sent anywhere (saved to `data/rejected/`).
- **Live publishing rules (in code):** live only if `publishMode` is `"auto"`, topic score ≥ 85 (`autoPublishMinScore`), reviewer approves, reviewer ran Google searches, no critical/major issues, accuracy ≥ 85, and under 1 live post per day. Otherwise it becomes a draft.
- **Disclosure:** every post ends with an AI-assistance note.
- **Undo:** `npm run unpublish` turns the latest live post back into a draft.
- **Untrusted input:** feed HTML, hidden characters and prompt-injection phrases are stripped or rejected before the LLM sees them.
- **Write separation:** only `publisher.js` uses write credentials.
- **Caps:** max posts per run and per week, max LLM calls per run (`config.json`).
- **No double posts:** drafted topics are remembered in `data/state.json`.
- **Link check:** posts may only link to your own posts or trusted docs sites (`trustedLinkDomains`); any other link blocks the post.
