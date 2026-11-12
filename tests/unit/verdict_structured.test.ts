import { describe, it, expect } from "vitest"
import { classifyVerdict } from "../../src/testrun/adapter"

describe("structured verdict parsing", () => {
  it("parses TAP failures as RED", () => {
    const out = "1..2\nok 1 - a\nnot ok 2 - b\n# fail 1\n"
    expect(classifyVerdict({ command: "t", stdout: out, stderr: "", exitCode: 1 }).verdict).toBe(false)
  })

  it("parses TAP all-pass as GREEN", () => {
    const out = "1..2\nok 1 - a\nok 2 - b\n"
    expect(classifyVerdict({ command: "t", stdout: out, stderr: "", exitCode: 0 }).verdict).toBe(true)
  })

  it("parses JUnit summary failures as RED", () => {
    const out = '<testsuite tests="3" failures="1" errors="0" skipped="1"></testsuite>'
    expect(classifyVerdict({ command: "t", stdout: out, stderr: "", exitCode: 1 }).verdict).toBe(false)
  })

  it("parses JUnit summary pass as GREEN", () => {
    const out = '<testsuite tests="3" failures="0" errors="0" skipped="0"></testsuite>'
    expect(classifyVerdict({ command: "t", stdout: out, stderr: "", exitCode: 0 }).verdict).toBe(true)
  })
})
