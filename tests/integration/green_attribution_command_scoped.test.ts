import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { writeFile } from "node:fs/promises"
import path from "node:path"
import { makeTempRepo } from "../helpers/repo"
import { createHarness } from "../helpers/harness"
import { TddState } from "../../src/types/cycle"

describe("GREEN attribution for command-scoped runs with summary-only output", () => {
  let repo: Awaited<ReturnType<typeof makeTempRepo>>
  let h: ReturnType<typeof createHarness>

  beforeEach(async () => {
    repo = await makeTempRepo()
    h = createHarness(repo.dir)
  })

  afterEach(async () => {
    await repo.cleanup()
  })

  it("accepts GREEN when explicitly scoped command passes but runner summary omits target file names", async () => {
    await h.callTool("tdd_start", { behavior: "add summary-only attribution" })

    await writeFile(
      path.join(repo.dir, "tests", "add.test.js"),
      `import { test } from "node:test";\nimport assert from "node:assert";\nimport { add } from "../src/add.js";\ntest("adds", () => assert.strictEqual(add(1,2), 3));\n`,
    )

    // Valid RED against real test output
    await h.callTool("tdd_commit_red", { command: "node --test tests/add.test.js" })
    let cycle = await h.store.getActive(h.sessionID)
    expect(cycle?.state).toBe(TddState.IMPLEMENTATION)

    // Implementation makes the real test pass
    await writeFile(path.join(repo.dir, "src", "add.js"), "export function add(a,b){return a+b}\n")

    // Wrapper actually runs the target test but prints only aggregate pass summary (no file/test names).
    await writeFile(
      path.join(repo.dir, "tests", "summary-runner.cjs"),
      [
        "const { spawnSync } = require('node:child_process');",
        "const target = process.argv[2];",
        "if (!target) { console.error('missing target'); process.exit(2); }",
        "const r = spawnSync(process.execPath, ['--test', target], { cwd: process.cwd(), encoding: 'utf8' });",
        "if (r.status !== 0) {",
        "  if (r.stdout) process.stdout.write(r.stdout);",
        "  if (r.stderr) process.stderr.write(r.stderr);",
        "  process.exit(r.status == null ? 1 : r.status);",
        "}",
        "process.stdout.write('\\n RUN  v5.1.0 /repo\\n\\n Test Files  1 passed (1)\\n      Tests  1 passed (1)\\n');",
        "process.exit(0);",
        "",
      ].join("\n"),
    )

    await h.callTool("tdd_verify_green", {
      command: "node tests/summary-runner.cjs tests/add.test.js",
      testFiles: ["tests/add.test.js"],
    })

    cycle = await h.store.getActive(h.sessionID)
    expect(cycle?.state).toBe(TddState.REFACTOR_REVIEW)
    const greens = cycle?.greenExecutions ?? []
    expect(greens.length).toBeGreaterThan(0)
    const last = greens[greens.length - 1]!
    expect(last.verdict).toBe(true)
    expect(last.verdictReason).toMatch(/explicitly scoped to intended targets/i)
    expect(last.verdictReason).not.toMatch(/Target test\(s\) not observed/i)
  })
})
