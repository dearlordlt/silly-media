/** localStorage-backed state for TTS form settings (legacy `tts_settings` parity). */
import { useEffect, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'

const PREFIX = 'silly.audio.'

export function usePersisted<T>(key: string, initial: T, isValid: (v: unknown) => v is T): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(PREFIX + key)
      if (raw === null) return initial
      const parsed: unknown = JSON.parse(raw)
      return isValid(parsed) ? parsed : initial
    } catch {
      return initial
    }
  })
  useEffect(() => {
    try {
      localStorage.setItem(PREFIX + key, JSON.stringify(value))
    } catch {
      /* quota / private mode: persistence is best-effort */
    }
  }, [key, value])
  return [value, setValue]
}

export const isString = (v: unknown): v is string => typeof v === 'string'
export const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
export const isBoolean = (v: unknown): v is boolean => typeof v === 'boolean'
