import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { writeFile, readFile } from "node:fs/promises"
import path from "node:path"
import { makeTempRepo, git } from "../helpers/repo"
import { createHarness } from "../helpers/harness"
import { TddState } from "../../src/types/cycle"

describe("TDD cycle integration", () => {
  let repo: Awaited<ReturnType<typeof makeTempRepo>>
  let h: ReturnType<typeof createHarness>

  beforeEach(async () => {
    repo = await makeTempRepo()
    h = createHarness(repo.dir)
  })

  afterEach(async () => {
    await repo.cleanup()
  })

  it("runs full RED -> GREEN -> finish cycle", async () => {
    await h.callTool("tdd_start", { behavior: "add add(a,b)" })
    let cycle = await h.store.getActive(h.sessionID)
    expect(cycle?.state).toBe(TddState.RED_TEST)

    // write failing test only (implementation missing = valid RED)
    await writeFile(
      path.join(repo.dir, "tests", "add.test.js"),
      `import { test } from "node:test";\nimport assert from "node:assert";\nimport { add } from "../src/add.js";\ntest("adds", () => assert.strictEqual(add(1,2), 3));\n`,
    )

    await h.callTool("tdd_commit_red", { command: "node --test tests/add.test.js" })
    cycle = await h.store.getActive(h.sessionID)
    expect(cycle?.state).toBe(TddState.IMPLEMENTATION)
    expect(cycle?.redCommit).toBeTruthy()

    // implement
    await writeFile(path.join(repo.dir, "src", "add.js"), "export function add(a,b){return a+b}\n")

    // verify green
    await h.callTool("tdd_verify_green", { command: "node --test tests/add.test.js" })
    cycle = await h.store.getActive(h.sessionID)
    expect(cycle?.state).toBe(TddState.REFACTOR_REVIEW)

    // commit green
    await h.callTool("tdd_commit_green", { refactor: "no", notes: "simple impl" })
    cycle = await h.store.getActive(h.sessionID)
    expect(cycle?.state).toBe(TddState.COMPLETE)
    expect(cycle?.greenCommit).toBeTruthy()

    // finish
    const report = await h.callTool("tdd_finish", {})
    expect(String(report)).toContain("TDD Cycle Complete")
    expect(await h.store.getActive(h.sessionID)).toBeNull()

    const log = (await git(repo.dir, ["log", "--oneline", "-n", "5"])).stdout
    expect(log).toContain("test: add failing test")
    expect(log).toContain("fix: implement")
  })

  it("allows RED commit for colocated tests under production paths (test patterns take precedence)", async () => {
    await h.callTool("tdd_start", { behavior: "colocated add" })

    // colocated test in src/** (matches productionPatterns) but is a test file
    await writeFile(
      path.join(repo.dir, "src", "add.test.js"),
      `import { test } from "node:test";\nimport assert from "node:assert";\nimport { add } from "./add.js";\ntest("adds", () => assert.strictEqual(add(1,2), 3));\n`,
    )

    await h.callTool("tdd_commit_red", { command: "node --test src/add.test.js" })
    const cycle = await h.store.getActive(h.sessionID)
    expect(cycle?.state).toBe(TddState.IMPLEMENTATION)
    expect(cycle?.redCommit?.files).toHaveProperty("src/add.test.js")
  })

  it("supports revert and amend-red correction flow", async () => {
    await h.callTool("tdd_start", { behavior: "mul" })

    // initial test only (implementation missing = valid RED)
    await writeFile(
      path.join(repo.dir, "tests", "mul.test.js"),
      `import { test } from "node:test";\nimport assert from "node:assert";\nimport { mul } from "../src/mul.js";\ntest("muls", () => assert.strictEqual(mul(2,3), 6));\n`,
    )
    await h.callTool("tdd_commit_red", { command: "node --test tests/mul.test.js" })

    // tentative impl
    await writeFile(path.join(repo.dir, "src", "mul.js"), "export function mul(a,b){return a*b}\n")
    let cycle = await h.store.getActive(h.sessionID)
    expect(cycle?.state).toBe(TddState.IMPLEMENTATION)

    // discover test needs correction -> revert impl (removes untracked impl)
    await h.callTool("tdd_revert_implementation", {})
    cycle = await h.store.getActive(h.sessionID)
    expect(cycle?.state).toBe(TddState.TEST_CORRECTION)
    let implGone = false
    try { await readFile(path.join(repo.dir, "src", "mul.js"), "utf8") } catch { implGone = true }
    expect(implGone).toBe(true)

    // correct test: still valid RED (module missing)
    await writeFile(
      path.join(repo.dir, "tests", "mul.test.js"),
      `import { test } from "node:test";\nimport assert from "node:assert";\nimport { mul } from "../src/mul.js";\ntest("multiplies", () => assert.strictEqual(mul(2,4), 8));\n`,
    )
    await h.callTool("tdd_amend_red", { command: "node --test tests/mul.test.js" })
    cycle = await h.store.getActive(h.sessionID)
    expect(cycle?.state).toBe(TddState.IMPLEMENTATION)
    expect(cycle?.amendCount).toBe(1)

    // implement corrected behavior
    await writeFile(path.join(repo.dir, "src", "mul.js"), "export function mul(a,b){return a*b}\n")
    await h.callTool("tdd_verify_green", { command: "node --test tests/mul.test.js" })
    await h.callTool("tdd_commit_green", { refactor: "no" })
    await h.callTool("tdd_finish", {})

    const log = (await git(repo.dir, ["log", "--oneline", "-n", "5"])).stdout
    const commits = log.trim().split("\n")
    // initial + amended RED + GREEN = 3 commits total (RED amended, not duplicated)
    expect(commits.length).toBe(3)
  })
})
