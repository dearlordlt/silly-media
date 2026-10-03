import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export interface AppSettings {
  apiBase: string
  confirmDeletes: boolean
}

interface AppState extends AppSettings {
  set: (patch: Partial<AppSettings>) => void
  setApiBase: (base: string) => void
}

export const DEFAULT_API_BASE = 'http://localhost:4201'

/**
 * A `?api=` query param lets ui.sh / users point the UI at a remote host
 * without rebuilding. It is session-scoped and MUST win over the persisted
 * setting, otherwise a stale localStorage value would silently override it.
 */
function baseFromQuery(): string | null {
  if (typeof window === 'undefined') return null
  const v = new URLSearchParams(window.location.search).get('api')
  return v ? v.replace(/\/+$/, '') : null
}

export const useApp = create<AppState>()(
  persist(
    (set) => ({
      apiBase: baseFromQuery() ?? DEFAULT_API_BASE,
      confirmDeletes: true,
      set: (patch) => set(patch),
      setApiBase: (apiBase) => set({ apiBase: apiBase.replace(/\/+$/, '') }),
    }),
    {
      name: 'silly-media-app',
      partialize: ({ apiBase, confirmDeletes }) => ({ apiBase, confirmDeletes }),
      merge: (persisted, current) => {
        const saved = (persisted ?? {}) as Partial<AppSettings>
        const query = baseFromQuery()
        return { ...current, ...saved, apiBase: query ?? saved.apiBase ?? current.apiBase }
      },
    },
  ),
)
