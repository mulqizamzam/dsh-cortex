/** Console-prefixed logging that cannot take the host down (DESIGN P4). */
export interface CortexLogger {
  info(...parts: unknown[]): void
  warn(...parts: unknown[]): void
}

export function makeLogger(scope: string): CortexLogger {
  const prefix = `[${scope}]`
  const emit = (level: 'info' | 'warn', parts: unknown[]): void => {
    try {
      const sink = console[level] ?? console.log
      sink.call(console, prefix, ...parts.map(part => (part instanceof Error ? part.message : part)))
    } catch {
      // A host without a usable console must not break a plugin.
    }
  }
  return { info: (...parts) => emit('info', parts), warn: (...parts) => emit('warn', parts) }
}

/** Usable message text for any thrown value; never empty. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message !== '' ? error.message : error.name
  if (typeof error === 'string' && error !== '') return error
  try {
    const json = JSON.stringify(error)
    if (typeof json === 'string' && json !== undefined) return json
  } catch {
    // fall through to String()
  }
  return String(error)
}

/** The store's uniform result envelope: a method never throws at its caller. */
/** Discriminated envelope; `data`/`error` are optional on the other arm so a
 * caller can read either field defensively while `result.ok` still narrows. */
export type CortexResult<T> = { ok: true; data: T; error?: undefined } | { ok: false; error: string; data?: undefined }

export function ok<T>(data: T): CortexResult<T> {
  return { ok: true, data }
}

export function fail<T = never>(error: unknown): CortexResult<T> {
  return { ok: false, error: errorMessage(error) }
}

/** Run an async body into the envelope, reporting the failure through `warn`. */
export async function attempt<T>(body: () => Promise<T>, warn?: (message: string) => void, label = ''): Promise<CortexResult<T>> {
  try {
    return ok(await body())
  } catch (error) {
    const message = errorMessage(error)
    warn?.(`${label === '' ? 'operation' : label} failed: ${message}`)
    return fail<T>(message)
  }
}
