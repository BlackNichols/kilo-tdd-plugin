import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { writeFile, mkdir } from "node:fs/promises"
import path from "node:path"
import { makeTempRepo } from "../helpers/repo"
import { createHarness } from "../helpers/harness"
import { TddState } from "../../src/types/cycle"

describe("multi-command GREEN coverage", () => {
  let repo: Awaited<ReturnType<typeof makeTempRepo>>
  let h: ReturnType<typeof createHarness>

  beforeEach(async () => {
    repo = await makeTempRepo()
    h = createHarness(repo.dir)
  })

  afterEach(async () => {
    await repo.cleanup()
  })

  it("requires all RED test files to be verified green before commit", async () => {
    await h.callTool("tdd_start", { behavior: "a and b" })

    await writeFile(
      path.join(repo.dir, "tests", "a.test.js"),
      `import { test } from "node:test";\nimport assert from "node:assert";\nimport { a } from "../src/ab.js";\ntest("a", () => assert.strictEqual(a(), 1));\n`,
    )
    await writeFile(
      path.join(repo.dir, "tests", "b.test.js"),
      `import { test } from "node:test";\nimport assert from "node:assert";\nimport { b } from "../src/ab.js";\ntest("b", () => assert.strictEqual(b(), 2));\n`,
    )
    await h.callTool("tdd_commit_red", { command: "node --test tests/a.test.js tests/b.test.js" })

    await writeFile(path.join(repo.dir, "src", "ab.js"), "export function a(){return 1}\nexport function b(){return 2}\n")

    // verify only subset
    const r1 = await h.callTool("tdd_verify_green", { command: "node --test tests/a.test.js" })
    expect(String(r1)).toMatch(/Missing RED tests/i)
    expect(String(r1)).toMatch(/tests\/b\.test\.js/)
    let cycle = await h.store.getActive(h.sessionID)
    expect(cycle?.state).toBe(TddState.GREEN_VERIFICATION)
    // cannot finish/commit until all RED tests covered (blocked by state + coverage gate)
    await expect(h.callTool("tdd_commit_green", { refactor: "no" })).rejects.toThrow(/not allowed in state GREEN_VERIFICATION|Not all RED test files are verified GREEN/)

    // verify remaining
    const r2 = await h.callTool("tdd_verify_green", { command: "node --test tests/b.test.js" })
    expect(String(r2)).toMatch(/GREEN verified for all required RED tests/i)
    cycle = await h.store.getActive(h.sessionID)
    expect(cycle?.state).toBe(TddState.REFACTOR_REVIEW)

    await expect(h.callTool("tdd_commit_green", { refactor: "no" })).resolves.toMatch(/GREEN committed/)
  })
})
