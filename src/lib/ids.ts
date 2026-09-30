import { randomBytes } from 'node:crypto'

/** 12 lowercase crypto hex chars — DESIGN §2 entry ids. */
export function newId(): string {
  return randomBytes(6).toString('hex')
}

/** Local-date `YYYY-MM-DD` (a log day is a human day, so local is deliberate). */
export function isoDate(date: Date = new Date()): string {
  const year = String(date.getFullYear()).padStart(4, '0')
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** ISO instant, colons replaced so it is usable inside a file name. */
export function isoStamp(date: Date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, '-')
}

export function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value)
}

/** Shift a `YYYY-MM-DD` by whole days, locally. */
export function shiftDate(date: string, days: number): string {
  const [year = 1970, month = 1, day = 1] = date.split('-').map(part => Number.parseInt(part, 10))
  const base = new Date(year, month - 1, day + days)
  return isoDate(base)
}

/** True for the id shape the store accepts (also blocks `../` traversal). */
export function isSafeKey(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(value)
}
