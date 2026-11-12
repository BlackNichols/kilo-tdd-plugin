import { describe, it, expect } from "vitest"
import { parseJsonReport, parseJunitReport } from "../../src/testrun/report"
import { classifyFromReport } from "../../src/testrun/adapter"

describe("structured report parsing/ingestion", () => {
  it("parses vitest/jest-like JSON report", () => {
    const r = parseJsonReport(JSON.stringify({ numTotalTests: 2, numPassedTests: 1, numFailedTests: 1, numPendingTests: 0, testResults: [{ name: "/tmp/tests/a.test.ts" }] }))
    expect(r?.format).toBe("json")
    expect(r?.failed).toBe(1)
    expect(r?.targets.some(t => t.includes("a.test.ts"))).toBe(true)
    const v = classifyFromReport(r!, { exitCode: 1, targets: ["/tmp/tests/a.test.ts"] })
    expect(v?.verdict).toBe(false)
  })

  it("parses pytest-json-report-like summary", () => {
    const r = parseJsonReport(JSON.stringify({ summary: { total: 3, passed: 3, failed: 0, skipped: 0 }, tests: [{ nodeid: "tests/test_x.py::test_ok" }] }))
    expect(r?.passed).toBe(3)
    const v = classifyFromReport(r!, { exitCode: 0, targets: ["tests/test_x.py"] })
    expect(v?.verdict).toBe(true)
  })

  it("fails closed when JSON report not attributable to targets", () => {
    const r = parseJsonReport(JSON.stringify({ numTotalTests: 1, numPassedTests: 1, numFailedTests: 0, numPendingTests: 0, testResults: [{ name: "other.test.ts" }] }))
    const v = classifyFromReport(r!, { exitCode: 0, targets: ["tests/wanted.test.ts"] })
    expect(v?.verdict).toBe(null)
  })

  it("parses JUnit report and classifies", () => {
    const xml = `<?xml version="1.0"?><testsuite tests="2" failures="1" errors="0" skipped="0"><testcase name="x" file="tests/a.test.js"/></testsuite>`
    const r = parseJunitReport(xml)
    expect(r?.format).toBe("junit")
    expect(r?.failed).toBe(1)
    expect(classifyFromReport(r!, { exitCode: 1, targets: ["tests/a.test.js"] })?.verdict).toBe(false)
    const ok = parseJunitReport(`<testsuite tests="1" failures="0" errors="0" skipped="0"></testsuite>`)
    expect(classifyFromReport(ok!, { exitCode: 0 })?.verdict).toBe(true)
  })

  it("treats zero-test or all-skipped reports as ambiguous", () => {
    const r = parseJsonReport(JSON.stringify({ numTotalTests: 0, numPassedTests: 0, numFailedTests: 0, numPendingTests: 0 }))
    expect(classifyFromReport(r!, { exitCode: 0 })?.verdict).toBe(null)
  })
})
