import Badge from './Badge.jsx'
import { outcomeOf, formatTime } from './outcomes.js'
import styles from './RunList.module.css'

export default function RunList({ runs, selectedId, onSelect }) {
  return (
    <nav className={styles.list} aria-label="Agent runs">
      {runs.map((run) => {
        const outcome = outcomeOf(run)
        const active = run.runId === selectedId
        return (
          <button
            key={run.runId}
            className={`${styles.item} ${active ? styles.active : ''}`}
            onClick={() => onSelect(run.runId)}
            aria-current={active}
          >
            <span className={styles.row}>
              <Badge tone={outcome.tone}>{outcome.label}</Badge>
              <span className={styles.mode}>{run.mode}</span>
            </span>
            <span className={styles.time}>{formatTime(run.startedAt)}</span>
            <span className={styles.message}>{run.message}</span>
          </button>
        )
      })}
    </nav>
  )
}
