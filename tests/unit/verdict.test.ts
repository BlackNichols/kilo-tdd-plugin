import { describe, it, expect } from "vitest"
import { classifyVerdict } from "../../src/testrun/adapter"

describe("classifyVerdict", () => {
  it("treats exit 0 with pass markers as GREEN", () => {
    const r = classifyVerdict({ command: "vitest", stdout: "Tests  1 passed (1)", stderr: "", exitCode: 0 })
    expect(r.verdict).toBe(true)
  })

  it("treats assertion failure as valid RED", () => {
    const r = classifyVerdict({
      command: "vitest",
      stdout: "FAIL  tests/x.test.ts\nAssertionError: expected 1 to be 2",
      stderr: "",
      exitCode: 1,
    })
    expect(r.verdict).toBe(false)
    expect(r.hadCompileError).toBe(false)
  })

  it("treats compile/syntax errors as ambiguous (not valid RED)", () => {
    const r = classifyVerdict({
      command: "vitest",
      stdout: "SyntaxError: Unexpected token",
      stderr: "",
      exitCode: 1,
    })
    expect(r.verdict).toBe(null)
    expect(r.hadCompileError).toBe(true)
  })

  it("treats skipped/no-tests as ambiguous", () => {
    const r = classifyVerdict({
      command: "vitest",
      stdout: "0 tests passed, 1 skipped",
      stderr: "",
      exitCode: 0,
    })
    expect(r.verdict).toBe(null)
    expect(r.skipped).toBe(true)
  })

  it("treats ambiguous nonzero as null", () => {
    const r = classifyVerdict({
      command: "vitest",
      stdout: "some unknown output",
      stderr: "",
      exitCode: 2,
    })
    expect(r.verdict).toBe(null)
  })

  it("parses node --test summary for RED and GREEN", () => {
    const red = classifyVerdict({ command: "node --test tests/a.test.js", stdout: "# tests 1\n# pass 0\n# fail 1\n", stderr: "", exitCode: 1, targetTests: ["tests/a.test.js"] })
    expect(red.verdict).toBe(false)
    const green = classifyVerdict({ command: "node --test tests/a.test.js", stdout: "# tests 1\n# pass 1\n# fail 0\n", stderr: "", exitCode: 0, targetTests: ["tests/a.test.js"] })
    expect(green.verdict).toBe(true)
  })

  it("fails closed when target tests not observed in output", () => {
    const r = classifyVerdict({ command: "vitest run tests/missing.test.ts", stdout: "Tests  1 passed (1)\nother.test.ts", stderr: "", exitCode: 0, targetTests: ["tests/missing.test.ts"] })
    expect(r.verdict).toBe(null)
    expect(r.reason).toMatch(/Target test/)
  })

  it("treats missing module failure as valid RED", () => {
    const r = classifyVerdict({ command: "node --test", stdout: "Error [ERR_MODULE_NOT_FOUND]: Cannot find module '../src/x.js'", stderr: "", exitCode: 1 })
    expect(r.verdict).toBe(false)
  })
})
