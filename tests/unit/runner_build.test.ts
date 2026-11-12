import { describe, it, expect } from "vitest"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { buildCommandForRun, runTest } from "../../src/testrun/runner"
import type { TestRunnerConfig } from "../../src/types/config"

describe("runner command building and report ingestion", () => {
  it("builds scoped command from runner config when enabled", () => {
    const runner: TestRunnerConfig = { id: "node", match: ["node --test"], command: "node --test", buildCommand: true, scopeArgs: (f) => [...f] }
    const built = buildCommandForRun({ cwd: "/repo", command: "node --test", targetTests: ["/repo/tests/a.test.js", "tests/b.test.js"] }, runner)
    expect(built.scoped).toBe(true)
    expect(built.command).toContain("node --test")
    expect(built.command).toContain("tests/a.test.js")
    expect(built.command).toContain("tests/b.test.js")
  })

  it("does not build when buildCommand disabled or missing targets/command", () => {
    const base = { cwd: "/repo", command: "npm test", targetTests: ["tests/a.test.js"] }
    const r1: TestRunnerConfig = { id: "npm", match: ["npm test"], command: "npm test", buildCommand: false, scopeArgs: (f)=>f }
    expect(buildCommandForRun(base, r1).scoped).toBe(false)
    const r2: TestRunnerConfig = { id: "npm", match: ["npm test"], buildCommand: true, scopeArgs: (f)=>f }
    expect(buildCommandForRun(base, r2).scoped).toBe(false)
    const r3: TestRunnerConfig = { id: "npm", match: ["npm test"], command: "npm test", buildCommand: true, scopeArgs: (f)=>f }
    expect(buildCommandForRun({ cwd: "/repo", command: "npm test", targetTests: [] }, r3).scoped).toBe(false)
  })

  it("ingests JSON report file as primary evidence when produced", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "kilo-tdd-run-"))
    try {
      const script = path.join(dir, "run.cjs")
      // writes a vitest-like json report to path passed after --out
      await writeFile(script, `const fs=require('fs'); const path=require('path'); const i=process.argv.indexOf('--out'); const out=process.argv[i+1]; fs.mkdirSync(path.dirname(out),{recursive:true}); fs.writeFileSync(out, JSON.stringify({numTotalTests:1,numPassedTests:0,numFailedTests:1,numPendingTests:0,testResults:[{name:'tests/a.test.js'}]})); process.exit(1);`)
      const runners: TestRunnerConfig[] = [{ id: "nodefake", match: ["node run.cjs"], command: "node run.cjs", buildCommand: false, reportFormat: "json", reportArgs: ["--out", "{file}"], scopeArgs: (f)=>f }]
      const exec = await runTest({ cwd: dir, command: `node run.cjs`, targetTests: ["tests/a.test.js"], runners })
      expect(exec.verdict).toBe(false)
      expect(exec.verdictReason).toMatch(/report:json/i)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("uses scoped built command when enabled", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "kilo-tdd-run-"))
    try {
      // script prints args and fails with assertion-like output
      await writeFile(path.join(dir, "rt.cjs"), `console.log(process.argv.slice(2).join('|')); console.log('1 failed'); process.exit(1);`)
      const runners: TestRunnerConfig[] = [{ id: "rt", match: ["node rt.cjs"], command: "node rt.cjs", buildCommand: true, reportFormat: "auto", scopeArgs: (f) => ["--run", ...f] }]
      const exec = await runTest({ cwd: dir, command: "node rt.cjs ignored", targetTests: [path.join(dir, "tests", "z.test.js")], runners })
      expect(exec.command).toContain("tests/z.test.js")
      expect(exec.verdictReason).toMatch(/scoped/i)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
