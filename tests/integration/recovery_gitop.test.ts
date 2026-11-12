import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { writeFile } from "node:fs/promises"
import path from "node:path"
import { makeTempRepo } from "../helpers/repo"
import { createHarness } from "../helpers/harness"

describe("recovery git operation detection", () => {
  let repo: Awaited<ReturnType<typeof makeTempRepo>>
  let h: ReturnType<typeof createHarness>

  beforeEach(async () => {
    repo = await makeTempRepo()
    h = createHarness(repo.dir)
  })

  afterEach(async () => {
    await repo.cleanup()
  })

  it("fails closed when a git operation is in progress during active cycle", async () => {
    await h.callTool("tdd_start", { behavior: "x" })
    await writeFile(
      path.join(repo.dir, "tests", "x.test.js"),
      `import { test } from "node:test";\nimport assert from "node:assert";\nimport { x } from "../src/x.js";\ntest("x", () => assert.strictEqual(x(), 1));\n`,
    )
    await h.callTool("tdd_commit_red", { command: "node --test tests/x.test.js" })
    const cycle = await h.store.getActive(h.sessionID)
    expect(cycle).toBeTruthy()

    // simulate in-progress merge
    await writeFile(path.join(repo.dir, ".git", "MERGE_HEAD"), "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n")

    const h2 = createHarness(repo.dir, h.sessionID)
    await expect(h2.store.getActive(h.sessionID)).rejects.toThrow(/Git operation in progress|Resolve git state/)
  })
})
