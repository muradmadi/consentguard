import { describe, it, expect, vi, afterEach } from 'vitest'
import { applyRedact } from './redact'

const PLACEHOLDER = '[REDACTED]'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('applyRedact', () => {
  it('replaces the whole value when no pattern is given', () => {
    const obj: any = { note: 'call alice on 555-0100' }
    expect(applyRedact(obj, 'note')).toBe(true)
    expect(obj.note).toBe(PLACEHOLDER)
  })

  it('replaces only what the pattern matched, and every occurrence of it', () => {
    const obj: any = { note: 'ids ID-12 and ID-34 seen' }
    expect(applyRedact(obj, 'note', 'ID-[0-9]+')).toBe(true)
    expect(obj.note).toBe(`ids ${PLACEHOLDER} and ${PLACEHOLDER} seen`)
  })

  /**
   * The return value is the audit contribution: a pattern that matched nothing
   * is not a transformation that fired, and recording one would put a removal
   * in the record that never happened.
   */
  it('reports nothing, and changes nothing, when the pattern misses', () => {
    const obj: any = { note: 'no ids at all' }
    expect(applyRedact(obj, 'note', 'ID-[0-9]+')).toBe(false)
    expect(obj.note).toBe('no ids at all')
  })

  /**
   * A pattern that will not compile is a rule that cannot be evaluated, and an
   * un-evaluated rule is not a reason to forward the value it was written to
   * remove. It fails closed to a full redaction.
   */
  it('redacts the whole value when the pattern will not compile', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const obj: any = { note: 'sensitive' }
    expect(applyRedact(obj, 'note', '([unclosed')).toBe(true)
    expect(obj.note).toBe(PLACEHOLDER)
  })

  it('redacts a number as its decimal text', () => {
    const obj: any = { ref: 4815162342 }
    expect(applyRedact(obj, 'ref', '162')).toBe(true)
    expect(obj.ref).toBe(`4815${PLACEHOLDER}342`)
  })

  /**
   * A number whose text the pattern misses must come back out a number. Writing
   * the stringified value back unconditionally would retype the field while
   * truthfully reporting that no transformation fired.
   */
  it('leaves a number a number when the pattern misses it', () => {
    const obj: any = { ref: 4815162342 }
    expect(applyRedact(obj, 'ref', 'nope')).toBe(false)
    expect(obj.ref).toBe(4815162342)
  })

  it('leaves a value that is not a scalar alone', () => {
    for (const value of [true, { a: 1 }, [1], null, undefined]) {
      const obj: any = { field: value }
      expect(applyRedact(obj, 'field'), `redacting ${JSON.stringify(value)}`).toBe(false)
      expect(obj.field).toBe(value)
    }
  })

  it('reports nothing for a key that was never there', () => {
    const obj: any = { keep: 1 }
    expect(applyRedact(obj, 'missing')).toBe(false)
    expect(obj).toEqual({ keep: 1 })
  })

  it('does not throw on a null or non-object container', () => {
    expect(applyRedact(null, 'field')).toBe(false)
    expect(applyRedact('a string', 'field')).toBe(false)
  })
})
