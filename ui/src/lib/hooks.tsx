/** Toasts + the shared API client hook. */
import { useRef } from 'react'
import { create } from 'zustand'
import { useApp } from './store'
import { SillyClient } from './api'

export interface Toast {
  id: number
  kind: 'info' | 'success' | 'error'
  title: string
  detail?: string
}

interface ToastState {
  toasts: Toast[]
  push: (t: Omit<Toast, 'id'>) => void
  dismiss: (id: number) => void
}

let nextId = 1
export const useToasts = create<ToastState>((set) => ({
  toasts: [],
  push: (t) => {
    const id = nextId++
    set((s) => ({ toasts: [...s.toasts, { ...t, id }] }))
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })), t.kind === 'error' ? 9000 : 4500)
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })),
}))

export const toast = {
  info: (title: string, detail?: string) => useToasts.getState().push({ kind: 'info', title, detail }),
  success: (title: string, detail?: string) => useToasts.getState().push({ kind: 'success', title, detail }),
  error: (title: string, detail?: string) => useToasts.getState().push({ kind: 'error', title, detail }),
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message
  return String(e)
}

/** A SillyClient bound to the configured base URL (recreated when the base changes). */
export function useClient(): SillyClient {
  const base = useApp((s) => s.apiBase)
  const ref = useRef(new SillyClient(base))
  if (ref.current.base !== base.replace(/\/+$/, '')) ref.current = new SillyClient(base)
  return ref.current
}
