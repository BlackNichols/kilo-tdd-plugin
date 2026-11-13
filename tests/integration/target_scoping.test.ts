import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { writeFile } from "node:fs/promises"
import path from "node:path"
import { makeTempRepo } from "../helpers/repo"
import { createHarness } from "../helpers/harness"

describe("target scoping", () => {
  let repo: Awaited<ReturnType<typeof makeTempRepo>>
  let h: ReturnType<typeof createHarness>

  beforeEach(async () => {
    repo = await makeTempRepo()
    h = createHarness(repo.dir)
  })

  afterEach(async () => {
    await repo.cleanup()
  })

  it("records inferred RED target tests on commit_red", async () => {
    await h.callTool("tdd_start", { behavior: "x" })
    await writeFile(
      path.join(repo.dir, "tests", "x.test.js"),
      `import { test } from "node:test";\nimport assert from "node:assert";\nimport { x } from "../src/x.js";\ntest("x", () => assert.strictEqual(x(), 1));\n`,
    )
    await h.callTool("tdd_commit_red", { command: "node --test tests/x.test.js" })
    const cycle = await h.store.getActive(h.sessionID)
    expect(cycle?.redExecution?.testFiles?.some((f) => f.endsWith("tests/x.test.js"))).toBe(true)
  })

  it("records protected test targets on verify_green", async () => {
    await h.callTool("tdd_start", { behavior: "x" })
    await writeFile(
      path.join(repo.dir, "tests", "x.test.js"),
      `import { test } from "node:test";\nimport assert from "node:assert";\nimport { x } from "../src/x.js";\ntest("x", () => assert.strictEqual(x(), 1));\n`,
    )
    await h.callTool("tdd_commit_red", { command: "node --test tests/x.test.js" })
    await writeFile(path.join(repo.dir, "src", "x.js"), "export function x(){return 1}\n")
    await h.callTool("tdd_verify_green", { command: "node --test tests/x.test.js" })
    const cycle = await h.store.getActive(h.sessionID)
    expect(cycle?.greenExecutions?.[0]?.testFiles?.length).toBeGreaterThan(0)
  })
})
