import { describe, it, expect } from 'vitest'
import { computeConsoleSegments } from '../src/removeUtil'

function applySegments(text: string, includeTrailingNewLine = true) {
  const segs = computeConsoleSegments(text, { methods: ['log','warn','error','info','debug'], preservePatterns: ['KEEP'], includeTrailingNewLine })
  return segs.sort((a,b)=> b.start - a.start).reduce((acc, s) => acc.slice(0, s.start) + acc.slice(s.end), text)
}

describe('computeConsoleSegments', () => {
  it('removes simple log', () => {
    const input = 'const a=1;\nconsole.log(a)\nconst b=2' 
    const out = applySegments(input)
    expect(out).not.toContain('console.log')
    expect(out).toContain('const a=1')
  })
  it('preserves pattern', () => {
    const input = 'console.log("KEEP", a)\nnext()' 
    const out = applySegments(input)
    expect(out).toContain('console.log')
  })
  it('removes nested parens', () => {
    const input = 'console.log(a, (b+c*(d+e)))\nX' 
    const out = applySegments(input)
    expect(out).toBe('X')
  })
  it('removes optional chaining', () => {
    const input = 'console?.warn("x")\nY' 
    const out = applySegments(input)
    expect(out).toBe('Y')
  })
  it('removes bracket access', () => {
    const input = 'console["error"](123)\nZ' 
    const out = applySegments(input)
    expect(out).toBe('Z')
  })

  it('keeps newline when configured', () => {
    const input = 'console.log(1)\nX'
    const out = applySegments(input, false)
    expect(out).toBe('\nX')
  })

  it('does not remove newline for inline statement', () => {
    const input = 'const a=1; console.log(a)\nX'
    const out = applySegments(input, true)
    expect(out).toContain('const a=1;')
    expect(out).toContain('\nX')
  })
})
