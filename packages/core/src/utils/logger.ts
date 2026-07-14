import type { Logger } from '../types/common.js'

/** A subset of `console`, so a host app can hand us its own sink. */
export type LogSink = Pick<Console, 'debug' | 'info' | 'warn' | 'error'>

export interface ConsoleLoggerOptions {
  /**
   * Emit `debug` lines.
   *
   * Off by default, and `resolveConfig` ties it to `strict` — which means it is on
   * in development and off in production. That is not tidiness: the pointer path
   * calls `log.debug` at up to 120 Hz, and template-literal construction plus a
   * `console.debug` that nobody reads is a measurable cost per frame. A no-op
   * function the JIT can inline is not.
   */
  readonly debug?: boolean

  /** Prepended to every line. Keep it greppable. */
  readonly prefix?: string

  /** Injectable so a test can assert on output without monkey-patching a global. */
  readonly sink?: LogSink
}

const noop = (): void => {}

/**
 * The default logger: `console`, prefixed, with `debug` gated.
 *
 * Swappable via `config.logger` — a government deployment routes map warnings into
 * its own telemetry, and a library that hard-codes `console.warn` makes that
 * impossible without patching a global.
 */
export function createConsoleLogger(options: ConsoleLoggerOptions = {}): Logger {
  const prefix = options.prefix ?? '[fleximap]'
  const sink = options.sink ?? console

  return {
    debug:
      options.debug === true
        ? (msg: string, ...args: unknown[]): void => sink.debug(`${prefix} ${msg}`, ...args)
        : noop,
    info: (msg: string, ...args: unknown[]): void => sink.info(`${prefix} ${msg}`, ...args),
    warn: (msg: string, ...args: unknown[]): void => sink.warn(`${prefix} ${msg}`, ...args),
    error: (msg: string, ...args: unknown[]): void => sink.error(`${prefix} ${msg}`, ...args),
  }
}

/** Discards everything. For tests that assert on behaviour rather than on noise. */
export const silentLogger: Logger = {
  debug: noop,
  info: noop,
  warn: noop,
  error: noop,
}
