import { describe, it, expect } from "vitest"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { runTest } from "../../src/testrun/runner"

describe("runner exit-mismatch diagnostics", () => {
  it("records a diagnostic when output indicates pass but exit is non-zero", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "kilo-tdd-diag-"))
    try {
      const script = path.join(dir, "pass-but-fail.cjs")
      await writeFile(script, "console.log('Tests  5 passed (5)'); process.exit(1);\n")
      const exec = await runTest({ cwd: dir, command: `node pass-but-fail.cjs` })
      expect(exec.exitCode).toBe(1)
      expect(exec.verdictReason).toMatch(/diag:exit-mismatch/i)
      expect(exec.verdictReason).toMatch(/Diagnostic: \.kilo\/tdd\/diagnostics\/exit-mismatch-.*\.json/)
      const rel = exec.verdictReason.match(/Diagnostic: (\.kilo\/tdd\/diagnostics\/exit-mismatch-[^\s]+\.json)/)?.[1]
      expect(rel).toBeTruthy()
      const content = JSON.parse(await readFile(path.join(dir, rel!), "utf8"))
      expect(content.kind).toBe("pass-output-nonzero-exit")
      expect(content.exitCode).toBe(1)
      expect(content.command).toContain("pass-but-fail.cjs")
      expect(content.stdout.text).toContain("5 passed")
      expect(content.note).toMatch(/non-zero/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("does not record a diagnostic for ordinary failing runs", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "kilo-tdd-diag-"))
    try {
      const script = path.join(dir, "red.cjs")
      await writeFile(script, "console.log('FAIL 1 failed'); process.exit(1);\n")
      const exec = await runTest({ cwd: dir, command: `node red.cjs` })
      expect(exec.verdict).toBe(false)
      expect(exec.verdictReason).not.toMatch(/exit-mismatch/i)
      await expect(readdir(path.join(dir, ".kilo", "tdd", "diagnostics"))).rejects.toBeTruthy()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
