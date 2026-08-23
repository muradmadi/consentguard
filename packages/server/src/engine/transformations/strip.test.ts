import { describe, it, expect } from 'vitest'
import { applyStrip } from './strip'

/**
 * The one primitive with no type gate: a strip removes the key whatever it
 * holds, which is what "this field must not leave" means. `applyHash` and
 * `applyRedact` transform a value and so need something to transform; this one
 * does not.
 *
 * The return value is the whole audit contribution. `true` becomes an entry
 * saying the transformation fired, so reporting it for a key that was never
 * there would put a removal in the record that never happened.
 */
describe('applyStrip', () => {
  it('removes the key and says it did', () => {
    const obj: any = { email: 'alice@example.com', keep: 1 }
    expect(applyStrip(obj, 'email')).toBe(true)
    expect(obj).toEqual({ keep: 1 })
  })

  it('reports nothing for a key that was never there', () => {
    const obj: any = { keep: 1 }
    expect(applyStrip(obj, 'email')).toBe(false)
    expect(obj).toEqual({ keep: 1 })
  })

  it('removes a value of any type, not only a string', () => {
    for (const value of [42, true, null, { nested: 1 }, [1, 2]]) {
      const obj: any = { field: value }
      expect(applyStrip(obj, 'field'), `stripping ${JSON.stringify(value)}`).toBe(true)
      expect('field' in obj).toBe(false)
    }
  })

  /**
   * A key holding `undefined` is present as far as the payload is concerned —
   * `JSON.stringify` drops it, but a rule that names it is asking for it gone,
   * and `in` is what distinguishes "present and empty" from "absent".
   */
  it('treats a key present with an undefined value as removable', () => {
    const obj: any = { field: undefined }
    expect(applyStrip(obj, 'field')).toBe(true)
    expect('field' in obj).toBe(false)
  })

  it('does not throw on a null or non-object container', () => {
    expect(applyStrip(null, 'field')).toBe(false)
    expect(applyStrip(undefined, 'field')).toBe(false)
    expect(applyStrip('a string', 'field')).toBe(false)
    expect(applyStrip(42, 'field')).toBe(false)
  })

  it('removes an array element by index, leaving the array a container', () => {
    const obj: any = ['keep', 'drop']
    expect(applyStrip(obj, '1')).toBe(true)
    expect(obj[1]).toBeUndefined()
  })
})
