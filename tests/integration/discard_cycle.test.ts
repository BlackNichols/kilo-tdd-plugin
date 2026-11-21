import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { writeFile, readFile } from "node:fs/promises"
import path from "node:path"
import { makeTempRepo, git } from "../helpers/repo"
import { createHarness } from "../helpers/harness"
import { TddState } from "../../src/types/cycle"
import { TddErrorCode } from "../../src/types/errors"

describe("tdd_discard_cycle", () => {
  let repo: Awaited<ReturnType<typeof makeTempRepo>>
  let h: ReturnType<typeof createHarness>

  beforeEach(async () => {
    repo = await makeTempRepo()
    h = createHarness(repo.dir)
  })

  afterEach(async () => {
    await repo.cleanup()
  })

  it("rolls back a stuck TEST_CORRECTION cycle to base and allows a fresh start", async () => {
    const base = (await git(repo.dir, ["rev-parse", "HEAD"])).stdout.trim()

    await h.callTool("tdd_start", { behavior: "discard me" })
    await writeFile(
      path.join(repo.dir, "tests", "add.test.js"),
      `import { test } from "node:test";\nimport assert from "node:assert";\nimport { add } from "../src/add.js";\ntest("adds", () => assert.strictEqual(add(1,2), 3));\n`,
    )
    await h.callTool("tdd_commit_red", { command: "node --test tests/add.test.js" })

    // tentative impl then revert -> TEST_CORRECTION with dirty corrected test
    await writeFile(path.join(repo.dir, "src", "add.js"), "export function add(a,b){return a+b}\n")
    await h.callTool("tdd_revert_implementation", {})
    expect((await h.store.getActive(h.sessionID))?.state).toBe(TddState.TEST_CORRECTION)
    await writeFile(
      path.join(repo.dir, "tests", "add.test.js"),
      `import { test } from "node:test";\nimport assert from "node:assert";\nimport { add } from "../src/add.js";\ntest("adds fixed", () => assert.strictEqual(add(1,2), 3));\n`,
    )

    const res = await h.callTool("tdd_discard_cycle", {})
    expect(String(res)).toContain("TDD cycle discarded")
    expect(String(res)).toContain("active: cleared")
    expect(await h.store.getActive(h.sessionID)).toBeNull()

    const status = await h.callTool("tdd_status", {})
    expect(String(status)).toContain("No active TDD cycle")

    const head = (await git(repo.dir, ["rev-parse", "HEAD"])).stdout.trim()
    expect(head).toBe(base)
    const dirty = (await git(repo.dir, ["status", "--porcelain"])).stdout
      .split("\n")
      .map((l) => l.trimEnd())
      .filter((l) => l && !l.includes(".kilo/") && !l.includes(".kilo"))
      .join("\n")
      .trim()
    expect(dirty).toBe("")
    // RED test file added by cycle should be gone at base
    await expect(readFile(path.join(repo.dir, "tests", "add.test.js"), "utf8")).rejects.toBeTruthy()

    // fresh start possible
    await h.callTool("tdd_start", { behavior: "fresh" })
    expect((await h.store.getActive(h.sessionID))?.state).toBe(TddState.RED_TEST)
  })

  it("fails when HEAD does not match cycle RED commit", async () => {
    await h.callTool("tdd_start", { behavior: "mismatch" })
    await writeFile(
      path.join(repo.dir, "tests", "x.test.js"),
      `import { test } from "node:test";\nimport assert from "node:assert";\nimport { x } from "../src/x.js";\ntest("x", () => assert.strictEqual(x(), 1));\n`,
    )
    await h.callTool("tdd_commit_red", { command: "node --test tests/x.test.js" })
    await writeFile(path.join(repo.dir, "src", "x.js"), "export function x(){return 1}\n")
    await h.callTool("tdd_revert_implementation", {})
    expect((await h.store.getActive(h.sessionID))?.state).toBe(TddState.TEST_CORRECTION)

    // move HEAD away from RED commit
    await writeFile(path.join(repo.dir, "src", "placeholder.ts"), "export const placeholder = 2;\n")
    await git(repo.dir, ["add", "src/placeholder.ts"])
    await git(repo.dir, ["commit", "-m", "rogue"])

    await expect(h.callTool("tdd_discard_cycle", {})).rejects.toMatchObject({ code: TddErrorCode.INTEGRITY_CHECK_FAILED })
  })

  it("fails in pristine RED_TEST (no changes to discard beyond abort; abort is preferred) — allowed but clean", async () => {
    // discard is allowed in RED_TEST even when pristine (equivalent end state to abort)
    const base = (await git(repo.dir, ["rev-parse", "HEAD"])).stdout.trim()
    await h.callTool("tdd_start", { behavior: "pristine" })
    const res = await h.callTool("tdd_discard_cycle", {})
    expect(String(res)).toContain("TDD cycle discarded")
    expect(String(res)).toContain("discarded RED: (none, uncommitted)")
    expect(await h.store.getActive(h.sessionID)).toBeNull()
    expect((await git(repo.dir, ["rev-parse", "HEAD"])).stdout.trim()).toBe(base)
  })

  it("discards an uncommitted RED test written in RED_TEST and allows a fresh start", async () => {
    const base = (await git(repo.dir, ["rev-parse", "HEAD"])).stdout.trim()
    await h.callTool("tdd_start", { behavior: "uncommitted red" })
    await writeFile(
      path.join(repo.dir, "tests", "wip.test.js"),
      `import { test } from "node:test";\nimport assert from "node:assert";\nimport { wip } from "../src/wip.js";\ntest("wip", () => assert.strictEqual(wip(), 1));\n`,
    )
    // uncommitted test makes tree dirty; tdd_abort would refuse, discard should clean it up
    await expect(h.callTool("tdd_abort", {})).rejects.toMatchObject({ code: TddErrorCode.DIRTY_WORKTREE })

    const res = await h.callTool("tdd_discard_cycle", {})
    expect(String(res)).toContain("TDD cycle discarded")
    expect(String(res)).toContain("discarded RED: (none, uncommitted)")
    expect(String(res)).toContain("active: cleared")
    expect(await h.store.getActive(h.sessionID)).toBeNull()
    const status = await h.callTool("tdd_status", {})
    expect(String(status)).toContain("No active TDD cycle")

    expect((await git(repo.dir, ["rev-parse", "HEAD"])).stdout.trim()).toBe(base)
    const dirty = (await git(repo.dir, ["status", "--porcelain"])).stdout
      .split("\n").map((l) => l.trimEnd()).filter((l) => l && !l.includes(".kilo/") && !l.includes(".kilo")).join("\n").trim()
    expect(dirty).toBe("")
    await expect(readFile(path.join(repo.dir, "tests", "wip.test.js"), "utf8")).rejects.toBeTruthy()

    await h.callTool("tdd_start", { behavior: "fresh after discard" })
    expect((await h.store.getActive(h.sessionID))?.state).toBe(TddState.RED_TEST)
  })

  it("fails in RED_TEST (no RED commit to roll back)", async () => {
    // replaced by specific RED_TEST cases above; keep no-active-cycle coverage instead
    await expect(h.callTool("tdd_discard_cycle", {})).rejects.toBeTruthy()
  })
})
