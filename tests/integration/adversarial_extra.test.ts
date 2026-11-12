import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { writeFile } from "node:fs/promises"
import path from "node:path"
import { makeTempRepo } from "../helpers/repo"
import { createHarness } from "../helpers/harness"

describe("extra adversarial cases", () => {
  let repo: Awaited<ReturnType<typeof makeTempRepo>>
  let h: ReturnType<typeof createHarness>

  beforeEach(async () => {
    repo = await makeTempRepo()
    h = createHarness(repo.dir)
  })
  afterEach(async () => { await repo.cleanup() })

  it("blocks git worktree and push/pull mutations", async () => {
    await h.callTool("tdd_start", { behavior: "x" })
    await expect(h.beforeTool("shell", { command: "git worktree add ../wt main" })).rejects.toThrow(/Direct git mutation is blocked/)
    await expect(h.beforeTool("bash", { command: "git push origin main" })).rejects.toThrow(/Direct git mutation is blocked/)
  })

  it("extracts rename targets from git diff patches", async () => {
    await h.callTool("tdd_start", { behavior: "x" })
    const patch = `diff --git a/src/old.js b/src/new.js\nsimilarity index 100%\nrename from src/old.js\nrename to src/new.js\n--- a/src/old.js\n+++ b/src/new.js\n`
    await expect(h.beforeTool("patch", { patchText: patch })).rejects.toThrow(/Production modifications are blocked/)
  })

  it("blocks php -r and deno eval style writes as suspicious", async () => {
    await h.callTool("tdd_start", { behavior: "x" })
    await expect(h.beforeTool("shell", { command: `php -r "file_put_contents('src/x.js','x');"` })).rejects.toThrow(/programmatic file writes|TDD enforcement/)
  })

  it("fails closed when reconciled cycle has implementation state without RED commit", async () => {
    await h.callTool("tdd_start", { behavior: "x" })
    await writeFile(
      path.join(repo.dir, "tests", "x.test.js"),
      `import { test } from "node:test";\nimport assert from "node:assert";\nimport { x } from "../src/x.js";\ntest("x", () => assert.strictEqual(x(), 1));\n`,
    )
    await h.callTool("tdd_commit_red", { command: "node --test tests/x.test.js" })
    const cycle = await h.store.getActive(h.sessionID)
    // corrupt persisted state to simulate crash-window inconsistency
    const { readFile, writeFile: wf } = await import("node:fs/promises")
    const cyclePath = path.join(repo.dir, ".kilo", "tdd", "cycles", `${cycle!.id}.json`)
    const saved = JSON.parse(await readFile(cyclePath, "utf8"))
    saved.state = "IMPLEMENTATION"
    saved.redCommit = null
    await wf(cyclePath, JSON.stringify(saved, null, 2))

    const h2 = createHarness(repo.dir, h.sessionID)
    await expect(h2.store.getActive(h.sessionID)).rejects.toThrow(/no RED commit recorded|Manual recovery required/)
  })
})
