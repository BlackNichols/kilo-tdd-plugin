import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { writeFile } from "node:fs/promises"
import path from "node:path"
import { makeTempRepo } from "../helpers/repo"
import { createHarness } from "../helpers/harness"
import { TddState } from "../../src/types/cycle"
import { TddErrorCode } from "../../src/types/errors"

describe("tdd_abort", () => {
  let repo: Awaited<ReturnType<typeof makeTempRepo>>
  let h: ReturnType<typeof createHarness>

  beforeEach(async () => {
    repo = await makeTempRepo()
    h = createHarness(repo.dir)
  })

  afterEach(async () => {
    await repo.cleanup()
  })

  it("aborts a freshly started cycle with no changes (inverse of tdd_start)", async () => {
    await h.callTool("tdd_start", { behavior: "abandon" })
    let cycle = await h.store.getActive(h.sessionID)
    expect(cycle?.state).toBe(TddState.RED_TEST)

    const res = await h.callTool("tdd_abort", {})
    expect(String(res)).toContain("TDD cycle aborted")
    expect(String(res)).toContain("active: cleared")
    expect(await h.store.getActive(h.sessionID)).toBeNull()

    const status = await h.callTool("tdd_status", {})
    expect(String(status)).toContain("No active TDD cycle")

    // aborted cycle persisted as closed/idle
    expect(cycle?.id).toBeTruthy()
    const stored = await h.store.get(cycle!.id)
    expect(stored?.state).toBe(TddState.IDLE)
    expect(stored?.log.some((l) => l.tool === "tdd_abort" && l.action === "abort" && l.ok)).toBe(true)
  })

  it("fails if uncommitted (non-excluded) changes exist", async () => {
    await h.callTool("tdd_start", { behavior: "dirty" })
    await writeFile(
      path.join(repo.dir, "tests", "x.test.js"),
      `import { test } from "node:test";\ntest("x", () => {});\n`,
    )
    await expect(h.callTool("tdd_abort", {})).rejects.toMatchObject({ code: TddErrorCode.DIRTY_WORKTREE })
    expect((await h.store.getActive(h.sessionID))?.state).toBe(TddState.RED_TEST)
  })

  it("fails after RED commit (cycle no longer pristine / state advanced)", async () => {
    await h.callTool("tdd_start", { behavior: "committed red" })
    await writeFile(
      path.join(repo.dir, "tests", "add.test.js"),
      `import { test } from "node:test";\nimport assert from "node:assert";\nimport { add } from "../src/add.js";\ntest("adds", () => assert.strictEqual(add(1,2), 3));\n`,
    )
    await h.callTool("tdd_commit_red", { command: "node --test tests/add.test.js" })
    expect((await h.store.getActive(h.sessionID))?.state).toBe(TddState.IMPLEMENTATION)
    await expect(h.callTool("tdd_abort", {})).rejects.toMatchObject({ code: TddErrorCode.STATE_MISMATCH })
  })

  it("fails when no active cycle exists", async () => {
    await expect(h.callTool("tdd_abort", {})).rejects.toBeTruthy()
  })
})
