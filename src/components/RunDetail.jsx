import Badge from './Badge.jsx'
import { outcomeOf, formatTime } from './outcomes.js'
import styles from './RunDetail.module.css'

function Section({ title, count, children }) {
  return (
    <section className={styles.section}>
      <h3 className={styles.sectionTitle}>
        {title}
        {count != null && <span className={styles.count}>{count}</span>}
      </h3>
      {children}
    </section>
  )
}

function ScoreBar({ value, threshold }) {
  const tone = value >= threshold ? styles.barPass : styles.barFail
  return (
    <div className={styles.bar} title={`${value} / 100 (threshold ${threshold})`}>
      <div className={`${styles.barFill} ${tone}`} style={{ width: `${value}%` }} />
      <div className={styles.barThreshold} style={{ left: `${threshold}%` }} />
    </div>
  )
}

export default function RunDetail({ run }) {
  const outcome = outcomeOf(run)
  const tokens = run.llmCalls.reduce((n, c) => n + c.inputTokens + c.outputTokens, 0)
  const threshold = run.threshold ?? 80

  return (
    <article className={styles.detail}>
      <header className={styles.head}>
        <div className={styles.headRow}>
          <Badge tone={outcome.tone}>{outcome.label}</Badge>
          <span className={styles.meta}>
            {formatTime(run.startedAt)} · {run.mode} · trigger: {run.trigger}
          </span>
        </div>
        <p className={styles.message}>{run.message}</p>
        <p className={styles.meta}>
          {run.llmCalls.length} LLM call{run.llmCalls.length === 1 ? '' : 's'} · {tokens.toLocaleString()} tokens
        </p>
      </header>

      {run.decision && (
        <Section title="Publish decision">
          {run.decision.factChecked === false && (
            <p className={styles.meta}>⚠️ Fact-check was switched off for this run ("factCheck": false)</p>
          )}
          {run.decision.live ? (
            <p className={styles.pass}>All rules passed, so the post was published live.</p>
          ) : (
            <ul className={styles.list}>
              {run.decision.reasons.map((r) => <li key={r}>{r}</li>)}
            </ul>
          )}
        </Section>
      )}

      {run.reviews?.map((review) => (
        <Section key={review.round} title={`AI fact-check, round ${review.round}`}>
          <div className={styles.reviewHead}>
            <Badge tone={review.verdict === 'approve' ? 'good' : review.verdict === 'revise' ? 'warn' : 'bad'}>{review.verdict}</Badge>
            <span className={styles.meta}>
              accuracy {review.accuracyScore} · {review.counts.critical} critical · {review.counts.major} major · {review.counts.minor} minor
            </span>
          </div>
          {review.summary && <p className={styles.summary}>{review.summary}</p>}
          {review.searches?.length > 0 || review.sources?.length > 0 ? (
            <p className={styles.meta}>
              {review.searches?.length ?? 0} web searches
              {review.sources?.length > 0 && <> · checked against: {review.sources.join(', ')}</>}
            </p>
          ) : (
            <p className={styles.meta}>⚠️ No web searches run</p>
          )}
          {review.claimsChecked?.length > 0 && (
            <ul className={styles.list}>
              {review.claimsChecked.map((c, i) => (
                <li key={i}>
                  <Badge tone={c.result === 'confirmed' ? 'good' : c.result === 'wrong' ? 'bad' : 'warn'}>{c.result}</Badge>{' '}
                  {c.claim} {c.source && <span className={styles.meta}>({c.source})</span>}
                </li>
              ))}
            </ul>
          )}
          {review.issues.length > 0 && (
            <ul className={styles.issues}>
              {review.issues.map((issue, i) => (
                <li key={i}>
                  <Badge tone={issue.severity === 'critical' ? 'bad' : issue.severity === 'major' ? 'warn' : 'neutral'}>{issue.severity}</Badge>{' '}
                  {issue.problem}
                  {issue.quote && <div className={styles.quote}>“{issue.quote}”</div>}
                  {issue.fix && <div className={styles.meta}>Fix: {issue.fix}</div>}
                </li>
              ))}
            </ul>
          )}
        </Section>
      ))}

      {run.published && (
        <Section title={run.published.live ? 'Published live' : 'Draft created'}>
          <div className={styles.draft}>
            <strong>{run.draft.title}</strong>
            <span className={styles.meta}>{run.draft.meta_description}</span>
            <span className={styles.meta}>
              {run.draft.wordCount} words · tags: {run.draft.tags.join(', ')} · via {run.published.publisher}
            </span>
            {run.published.url?.startsWith('http') ? (
              <a href={run.published.url} target="_blank" rel="noreferrer">{run.published.live ? 'Open post ↗' : 'Open draft ↗'}</a>
            ) : (
              <code>{run.published.url}</code>
            )}
          </div>
        </Section>
      )}

      {run.draft?.failures?.length > 0 && (
        <Section title="Quality gate failures" count={run.draft.failures.length}>
          <ul className={styles.list}>
            {run.draft.failures.map((f) => <li key={f}>{f}</li>)}
          </ul>
        </Section>
      )}

      {run.scored.length > 0 && (
        <Section title="Scored topics" count={run.scored.length}>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Topic</th>
                  <th className={styles.scoreCol}>Score</th>
                </tr>
              </thead>
              <tbody>
                {run.scored.map((s) => (
                  <tr key={s.title}>
                    <td>
                      <div className={styles.topic}>
                        {s.link ? <a href={s.link} target="_blank" rel="noreferrer">{s.title}</a> : s.title}
                      </div>
                      <div className={styles.meta}>{s.source} · {s.reason}</div>
                      <div className={styles.parts}>
                        relevance {s.scores.relevance} · gap {s.scores.gap} · info gain {s.scores.infoGain} · freshness {s.scores.freshness}
                      </div>
                    </td>
                    <td className={styles.scoreCol}>
                      <span className={styles.total}>{s.total}</span>
                      <ScoreBar value={s.total} threshold={threshold} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      {run.rejectedItems.length > 0 && (
        <Section title="Blocked as hostile input" count={run.rejectedItems.length}>
          <ul className={styles.list}>
            {run.rejectedItems.map((r) => (
              <li key={r.title + r.source}>
                <Badge tone="bad">blocked</Badge> <strong>{r.title}</strong>{' '}
                <span className={styles.meta}>({r.source}): {r.reason}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {run.skipped.length > 0 && (
        <Section title="Skipped before scoring" count={run.skipped.length}>
          <ul className={styles.list}>
            {run.skipped.map((s) => (
              <li key={s.title + s.source}>
                {s.title} <span className={styles.meta}>({s.source}): {s.reason}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section title="Sources checked" count={run.sources.length}>
        <ul className={styles.list}>
          {run.sources.map((s) => (
            <li key={s.name}>
              <Badge tone={s.ok ? 'good' : 'bad'}>{s.ok ? 'ok' : 'failed'}</Badge> {s.name}{' '}
              <span className={styles.meta}>{s.ok ? `${s.items} items` : s.error}</span>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Step log" count={run.steps.length}>
        <ol className={styles.steps}>
          {run.steps.map((step, i) => (
            <li key={i}>
              <code className={styles.stage}>{step.stage}</code> {step.message}
            </li>
          ))}
        </ol>
      </Section>
    </article>
  )
}
