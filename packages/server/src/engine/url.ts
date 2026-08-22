import type { DestinationRule, TransformationRecord } from '@sluice/shared'
import { scrubPayload, type ScrubOptions } from './transformer'

export interface UrlScrubResult {
  url: string
  report: TransformationRecord[]
}

/**
 * Scrub a URL's query string with the same two passes that scrub a body.
 *
 * A beacon carries as much personal data in its query string as in its body —
 * a gtag or pixel request carries all of it there — and the generic passthrough
 * forwards to the URL the browser originally targeted. Scrubbing only the body
 * left that half of every request untouched.
 *
 * Only the query is rewritten. A path segment is the address of the vendor's
 * API rather than payload, and replacing part of it changes what is being
 * called; a beacon does not put its payload there.
 *
 * Report paths are prefixed with `?` so an audit entry says which half of the
 * request it came from, and cannot be mistaken for a dotted body path.
 */
export function scrubUrl(
  url: string,
  rule: DestinationRule,
  options: ScrubOptions = {},
): UrlScrubResult {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    // Not a URL we can take apart, and not one `fetch` will accept either, so
    // the forward fails and is audited as failed rather than leaking.
    return { url, report: [] }
  }

  const keys = [...new Set(parsed.searchParams.keys())]
  if (keys.length === 0) return { url, report: [] }

  const params: Record<string, string | string[]> = {}
  for (const key of keys) {
    const values = parsed.searchParams.getAll(key)
    params[key] = values.length > 1 ? values : values[0]
  }

  const scrub = scrubPayload(params, rule, options)

  // Nothing fired: hand back the original string rather than a re-encoded one.
  // Round-tripping through URLSearchParams rewrites escapes that the vendor
  // may well be comparing against a signature.
  if (scrub.report.length === 0) return { url, report: [] }

  const rebuilt = new URLSearchParams()
  for (const [key, value] of Object.entries(scrub.payload as Record<string, unknown>)) {
    if (value === undefined || value === null) continue
    if (Array.isArray(value)) value.forEach((v) => rebuilt.append(key, String(v)))
    else rebuilt.append(key, String(value))
  }
  parsed.search = rebuilt.toString()

  return {
    url: parsed.toString(),
    report: scrub.report.map((entry) => ({ ...entry, path: `?${entry.path}` })),
  }
}
