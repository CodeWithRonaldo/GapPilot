import { useCallback, useEffect, useState } from 'react'
import StatCards from './components/StatCards.jsx'
import RunList from './components/RunList.jsx'
import RunDetail from './components/RunDetail.jsx'
import styles from './App.module.css'

export default function App() {
  const [runs, setRuns] = useState([])
  const [selectedId, setSelectedId] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const loadRuns = useCallback(
    () =>
      fetch('/api/runs')
        .then((res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          return res.json()
        })
        .then((data) => {
          setRuns(data)
          setError(null)
        })
        .catch((err) => setError(err.message))
        .finally(() => setLoading(false)),
    [],
  )

  useEffect(() => {
    loadRuns()
  }, [loadRuns])

  const refresh = () => {
    setLoading(true)
    loadRuns()
  }

  const selected = runs.find((r) => r.runId === selectedId) ?? runs[0]

  return (
    <div className={styles.app}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.logo}>GapPilot</h1>
          <p className={styles.tagline}>No real opportunity = no post. Every run, every decision, on the record.</p>
        </div>
        <button className={styles.refresh} onClick={refresh} disabled={loading}>
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </header>

      {error && <p className={styles.error}>Could not load runs: {error}</p>}

      {!loading && !runs.length ? (
        <div className={styles.empty}>
          <h2>No runs yet</h2>
          <p>
            Run <code>npm run agent:mock</code> (no keys needed) or <code>npm run agent</code>, then press Refresh.
          </p>
        </div>
      ) : (
        <>
          <StatCards runs={runs} />
          <main className={styles.main}>
            <RunList runs={runs} selectedId={selected?.runId} onSelect={setSelectedId} />
            {selected && <RunDetail run={selected} />}
          </main>
        </>
      )}
    </div>
  )
}
