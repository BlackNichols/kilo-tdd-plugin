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

  it("classifies Playwright webServer port conflict as infrastructure failure", () => {
    const r = classifyVerdict({
      command: "npx playwright test e2e/spellbooks.spec.ts --reporter=line",
      stdout: "Error: http://127.0.0.1:4173 is already used, make sure that nothing is running on the port/url or set reuseExistingServer:true in config.webServer.\n\n",
      stderr: "npm notice run anima-spellbook@0.0.1 npx\n",
      exitCode: 1,
      targetTests: ["/home/hanonym/documents/projects/AnimaSpellBook/e2e/spellbooks.spec.ts"],
    })
    expect(r.verdict).toBe(null)
    expect(r.debug?.path).toBe("infra")
    expect(r.reason).toMatch(/port\/address in use/i)
  })

  it("attributes scoped Playwright pass when output mentions target file but no other test files", async () => {
    const target = "e2e/spellbooks.spec.ts"
    const r = classifyVerdict({
      command: `npx playwright test ${target} -g "case"`,
      stdout: `  [chromium] › ${target}:179:5 › Spellbook UI › deleting a non-last named section can move its spells\n\n  1 passed (16.9s)\n`,
      stderr: "",
      exitCode: 0,
      targetTests: [target],
    })
    expect(r.verdict).toBe(true)
    expect(r.reason).toMatch(/passed/i)
    const exec = await runTest({
      cwd: process.cwd(),
      command: `node -e "console.log('[chromium] > ${target}:1:1 > case'); console.log('1 passed (1.0s)')"`,
      targetTests: [target],
      runners: [{ id: "nodee", match: ["node -e"], scopeArgs: (f) => [...f] }],
    })
    expect(exec.verdict).toBe(true)
    expect(exec.attributedFiles).toContain(target)
  })

  it("returns ambiguous verdict for pass output with nonzero exit", () => {
    const r = classifyVerdict({
      command: "npx playwright test e2e/spellbooks.spec.ts --reporter=line",
      stdout: "  [chromium] › e2e/spellbooks.spec.ts:1:1 › ok\n\n  1 passed (5.0s)\n",
      stderr: "",
      exitCode: 1,
      targetTests: ["e2e/spellbooks.spec.ts"],
    })
    expect(r.verdict).toBe(null)
    expect(r.debug?.path).toBe("pass-signal-nonzero-exit")
    expect(r.reason).toMatch(/cannot confirm valid GREEN/i)
  })

  it("treats timed out run as ambiguous, not RED", () => {
    const r = classifyVerdict({
      command: "npx playwright test e2e/spellbooks.spec.ts --reporter=line",
      stdout: "Running 16 tests using 1 worker\n[1/16] e2e/spellbooks.spec.ts:8:1 › test\n",
      stderr: "",
      exitCode: 1,
      targetTests: ["e2e/spellbooks.spec.ts"],
      timedOut: true,
    })
    expect(r.verdict).toBe(null)
    expect(r.debug?.path).toBe("timeout")
    expect(r.reason).toMatch(/timed out|terminated/i)
  })
})
