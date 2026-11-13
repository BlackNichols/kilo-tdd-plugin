import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { writeFile, readFile } from "node:fs/promises"
import path from "node:path"
import { makeTempRepo } from "../helpers/repo"
import { createHarness } from "../helpers/harness"
import { TddState } from "../../src/types/cycle"

describe("implementation snapshot/restore", () => {
  let repo: Awaited<ReturnType<typeof makeTempRepo>>
  let h: ReturnType<typeof createHarness>

  beforeEach(async () => {
    repo = await makeTempRepo()
    h = createHarness(repo.dir)
  })

  afterEach(async () => {
    await repo.cleanup()
  })

  it("snapshots reverted implementation as detached commit and restores after amend", async () => {
    await h.callTool("tdd_start", { behavior: "mul" })
    await writeFile(
      path.join(repo.dir, "tests", "mul.test.js"),
      `import { test } from "node:test";\nimport assert from "node:assert";\nimport { mul } from "../src/mul.js";\ntest("muls", () => assert.strictEqual(mul(2,3), 6));\n`,
    )
    await h.callTool("tdd_commit_red", { command: "node --test tests/mul.test.js" })

    await writeFile(path.join(repo.dir, "src", "mul.js"), "export function mul(a,b){return a*b}\n")
    const revertMsg = String(await h.callTool("tdd_revert_implementation", {}))
    expect(revertMsg).toMatch(/Snapshot:/)
    expect(revertMsg).toMatch(/tdd_restore_implementation/)

    let cycle = await h.store.getActive(h.sessionID)
    expect(cycle?.state).toBe(TddState.TEST_CORRECTION)
    expect(cycle?.implSnapshots?.length).toBe(1)
    await expect(readFile(path.join(repo.dir, "src", "mul.js"), "utf8")).rejects.toBeTruthy()

    // amend RED (still valid RED: module missing)
    await writeFile(
      path.join(repo.dir, "tests", "mul.test.js"),
      `import { test } from "node:test";\nimport assert from "node:assert";\nimport { mul } from "../src/mul.js";\ntest("multiplies", () => assert.strictEqual(mul(2,4), 8));\n`,
    )
    await h.callTool("tdd_amend_red", { command: "node --test tests/mul.test.js" })
    cycle = await h.store.getActive(h.sessionID)
    expect(cycle?.state).toBe(TddState.IMPLEMENTATION)

    const restored = String(await h.callTool("tdd_restore_implementation", {}))
    expect(restored).toMatch(/Implementation restored/)
    const impl = await readFile(path.join(repo.dir, "src", "mul.js"), "utf8")
    expect(impl).toContain("a*b")

    await h.callTool("tdd_verify_green", { command: "node --test tests/mul.test.js" })
    await h.callTool("tdd_commit_green", { refactor: "no" })
    await h.callTool("tdd_finish", {})
  })
})
