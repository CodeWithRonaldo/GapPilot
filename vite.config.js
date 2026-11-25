import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { readdir, readFile } from 'node:fs/promises'

// Serves the agent's audit traces (data/traces/*.json) to the dashboard at /api/runs.
// Read-only: the dashboard can look at runs but never trigger writes.
function gapPilotData() {
  return {
    name: 'gappilot-data',
    configureServer(server) {
      server.middlewares.use('/api/runs', async (_req, res) => {
        try {
          const dir = new URL('./data/traces/', import.meta.url)
          const files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort().reverse().slice(0, 100)
          const runs = await Promise.all(files.map(async (f) => JSON.parse(await readFile(new URL(f, dir), 'utf8'))))
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify(runs))
        } catch {
          res.setHeader('Content-Type', 'application/json')
          res.end('[]')
        }
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), gapPilotData()],
  server: { watch: { ignored: ['**/data/**'] } },
})
