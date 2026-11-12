import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { writeFile } from "node:fs/promises"
import path from "node:path"
import { makeTempRepo, git } from "../helpers/repo"
import { createHarness } from "../helpers/harness"

describe("recovery and reconciliation", () => {
  let repo: Awaited<ReturnType<typeof makeTempRepo>>
  let h: ReturnType<typeof createHarness>

  beforeEach(async () => {
    repo = await makeTempRepo()
    h = createHarness(repo.dir)
  })

  afterEach(async () => {
    await repo.cleanup()
  })

  it("fails closed if RED commit is missing from git history", async () => {
    await h.callTool("tdd_start", { behavior: "x" })
    await writeFile(
      path.join(repo.dir, "tests", "x.test.js"),
      `import { test } from "node:test";\nimport assert from "node:assert";\nimport { x } from "../src/x.js";\ntest("x", () => assert.strictEqual(x(), 1));\n`,
    )
    await h.callTool("tdd_commit_red", { command: "node --test tests/x.test.js" })
    const cycle = await h.store.getActive(h.sessionID)
    expect(cycle?.redCommit?.sha).toBeTruthy()

    // simulate persisted state disagreeing with git: RED commit object missing
    const { readFile: rf, writeFile: wf } = await import("node:fs/promises")
    const cyclePath = path.join(repo.dir, ".kilo", "tdd", "cycles", `${cycle!.id}.json`)
    const saved = JSON.parse(await rf(cyclePath, "utf8"))
    saved.redCommit.sha = "0000000000000000000000000000000000000000"
    saved.redCommit.shortSha = "0000000"
    await wf(cyclePath, JSON.stringify(saved, null, 2))

    // new store instance simulates reload/recovery
    const h2 = createHarness(repo.dir, h.sessionID)
    await expect(h2.store.getActive(h.sessionID)).rejects.toThrow(/RED commit .* no longer exists|inconsistent|Manual recovery/)
  })

  it("isolates cycles per session", async () => {
    const h1 = createHarness(repo.dir, "ses_a")
    const h2 = createHarness(repo.dir, "ses_b")
    await h1.callTool("tdd_start", { behavior: "a" })
    expect(await h1.store.getActive("ses_a")).toBeTruthy()
    expect(await h2.store.getActive("ses_b")).toBeNull()

    // second session cannot start if git dirty due to first? first only stored state; git clean
    await h2.callTool("tdd_start", { behavior: "b" })
    expect((await h1.store.getActive("ses_a"))?.id).not.toBe((await h2.store.getActive("ses_b"))?.id)
  })
})
