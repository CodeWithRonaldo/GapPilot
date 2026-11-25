// Display labels and colour tones for each run outcome.
export const OUTCOMES = {
  published: { label: 'Published live', tone: 'accent' },
  drafted: { label: 'Draft created', tone: 'good' },
  no_opportunity: { label: 'Stayed silent', tone: 'neutral' },
  blocked: { label: 'Blocked', tone: 'warn' },
  killed: { label: 'Kill switch', tone: 'bad' },
  error: { label: 'Error', tone: 'bad' },
}

export const outcomeOf = (run) => OUTCOMES[run.outcome] ?? { label: run.outcome ?? 'Unknown', tone: 'neutral' }

export function formatTime(iso) {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}
