import styles from './StatCards.module.css'

export default function StatCards({ runs }) {
  const count = (outcome) => runs.filter((r) => r.outcome === outcome).length
  const injections = runs.reduce((n, r) => n + (r.rejectedItems?.length ?? 0), 0)

  const stats = [
    { label: 'Total runs', value: runs.length },
    { label: 'Published / drafted', value: `${count('published')} / ${count('drafted')}` },
    { label: 'Stayed silent', value: count('no_opportunity'), hint: 'No topic beat the threshold' },
    { label: 'Hostile items blocked', value: injections, hint: 'Feed items rejected by the sanitizer' },
  ]

  return (
    <section className={styles.grid}>
      {stats.map((s) => (
        <div key={s.label} className={styles.card} title={s.hint}>
          <span className={styles.value}>{s.value}</span>
          <span className={styles.label}>{s.label}</span>
        </div>
      ))}
    </section>
  )
}
