/**
 * A deliberately tiny semver range check.
 *
 * We need exactly one thing — "does plugin X's version satisfy dependent Y's
 * declared range?" — and pulling a 40 kB semver library into the *browser bundle*
 * of a mapping kernel to answer it is not a trade worth making. Supports the
 * ranges that actually appear in a plugin manifest: `^1.2.3`, `~1.2.3`, `>=1.2.0`,
 * `1.2.3`, and `*`.
 *
 * If a plugin author needs full semver semantics (pre-release tags, `||` unions),
 * they are describing a dependency graph too clever for a plugin manifest, and the
 * honest answer is to simplify the manifest.
 */

interface Parsed {
  major: number
  minor: number
  patch: number
}

function parse(version: string): Parsed | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim())
  if (!m) return null
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) }
}

function compare(a: Parsed, b: Parsed): number {
  if (a.major !== b.major) return a.major - b.major
  if (a.minor !== b.minor) return a.minor - b.minor
  return a.patch - b.patch
}

/**
 * @param version - the installed plugin's version, e.g. `'1.4.2'`
 * @param range   - the dependent's declared range, e.g. `'^1.0.0'`
 */
export function satisfies(version: string, range: string): boolean {
  const trimmed = range.trim()
  if (trimmed === '*' || trimmed === '') return true

  const v = parse(version)
  if (!v) return false

  const operator = /^(\^|~|>=|>|<=|<|=)?\s*(.*)$/.exec(trimmed)
  if (!operator) return false

  const op = operator[1] ?? '='
  const target = parse(operator[2] ?? '')
  if (!target) return false

  switch (op) {
    case '^':
      // Compatible-within-major. 0.x is special: every 0.x bump is breaking by
      // convention, so ^0.2.0 does NOT accept 0.3.0. Getting this wrong is how a
      // pre-1.0 plugin ecosystem silently breaks itself.
      if (target.major === 0) {
        return v.major === 0 && v.minor === target.minor && compare(v, target) >= 0
      }
      return v.major === target.major && compare(v, target) >= 0

    case '~':
      return v.major === target.major && v.minor === target.minor && compare(v, target) >= 0

    case '>=':
      return compare(v, target) >= 0
    case '>':
      return compare(v, target) > 0
    case '<=':
      return compare(v, target) <= 0
    case '<':
      return compare(v, target) < 0
    case '=':
      return compare(v, target) === 0
    default:
      return false
  }
}
