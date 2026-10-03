/** "Copy request" snippets (legacy copyCurl / copyJson / copyPython). */
import type { GenerateRequest } from '../../lib/types'

export type SnippetKind = 'curl' | 'json' | 'python'

export function requestSnippet(kind: SnippetKind, url: string, req: GenerateRequest): string {
  if (kind === 'json') return JSON.stringify(req, null, 2)
  if (kind === 'curl') {
    // Escape single quotes for the POSIX shell single-quoted body.
    const body = JSON.stringify(req).replace(/'/g, `'\\''`)
    return `curl -X POST "${url}" \\\n  -H "Content-Type: application/json" \\\n  -d '${body}' \\\n  --output image.png`
  }
  // JSON literals are valid Python except for true/false/null.
  const json = JSON.stringify(req, null, 4)
    .replace(/: true\b/g, ': True')
    .replace(/: false\b/g, ': False')
    .replace(/: null\b/g, ': None')
    .replace(/\n/g, '\n    ')
  return `import requests

response = requests.post(
    "${url}",
    json=${json}
)

with open("image.png", "wb") as f:
    f.write(response.content)`
}
