import { describe, it, expect } from "vitest"
import { classifyVerdict, matchRunner } from "../../src/testrun/adapter"
import { DEFAULT_CONFIG } from "../../src/types/config"
import { runTest } from "../../src/testrun/runner"

describe("runner/config integration", () => {
  it("matches configured runners by command substring", () => {
    const r = matchRunner("npx vitest run tests/a.test.ts", DEFAULT_CONFIG.testRunners)
    expect(r?.id).toBe("vitest")
  })

  it("applies runner skipIndicator when present", () => {
    const out = "test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out"
    const r = classifyVerdict({ command: "cargo test", stdout: out, stderr: "", exitCode: 0, skipIndicator: /0 passed; 0 failed/i })
    expect(r.skipped).toBe(true)
    expect(r.verdict).toBe(null)
  })

  it("runTest annotates verdict with matched runner id", async () => {
    const exec = await runTest({ cwd: process.cwd(), command: "node -e \"process.exit(1)\"", runners: [{ id: "nodee", match: ["node -e"], scopeArgs: (f)=>[...f] }] })
    expect(exec.verdictReason).toMatch(/\[runner:nodee\]/)
  })
})
