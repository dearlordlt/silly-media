/** Per-profile persisted TTS form settings (legacy `tts_settings` parity), stored via `kv`. */
import { useEffect, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import { kv } from '../../lib/kv'

const PREFIX = 'silly.audio.'

export function usePersisted<T>(key: string, initial: T, isValid: (v: unknown) => v is T): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => {
    const parsed = kv.getJson<unknown>(PREFIX + key, initial)
    return isValid(parsed) ? parsed : initial
  })
  useEffect(() => {
    kv.setJson(PREFIX + key, value)
  }, [key, value])
  return [value, setValue]
}

export const isString = (v: unknown): v is string => typeof v === 'string'
export const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
export const isBoolean = (v: unknown): v is boolean => typeof v === 'boolean'
