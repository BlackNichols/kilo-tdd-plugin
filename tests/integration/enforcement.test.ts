import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { writeFile } from "node:fs/promises"
import path from "node:path"
import { makeTempRepo, git } from "../helpers/repo"
import { createHarness } from "../helpers/harness"
import { TddState } from "../../src/types/cycle"

describe("enforcement", () => {
  let repo: Awaited<ReturnType<typeof makeTempRepo>>
  let h: ReturnType<typeof createHarness>

  beforeEach(async () => {
    repo = await makeTempRepo()
    h = createHarness(repo.dir)
  })

  afterEach(async () => {
    await repo.cleanup()
  })

  it("refuses to start with dirty working tree", async () => {
    await writeFile(path.join(repo.dir, "src", "dirty.ts"), "x")
    await expect(h.callTool("tdd_start", { behavior: "x" })).rejects.toThrow(/Working tree is not clean/)
  })

  it("blocks production edits in RED_TEST via hook", async () => {
    await h.callTool("tdd_start", { behavior: "x" })
    await expect(
      h.beforeTool("edit", { filePath: path.join(repo.dir, "src", "foo.ts") }),
    ).rejects.toThrow(/Production modifications are blocked/)
  })

  it("blocks direct git commit via shell hook during active cycle", async () => {
    await h.callTool("tdd_start", { behavior: "x" })
    await expect(h.beforeTool("shell", { command: "git commit -m 'sneaky'" })).rejects.toThrow(
      /Direct git mutation is blocked/,
    )
  })

  it("blocks modifying protected test after RED commit", async () => {
    await h.callTool("tdd_start", { behavior: "x" })
    await writeFile(
      path.join(repo.dir, "tests", "x.test.js"),
      `import { test } from "node:test";\nimport assert from "node:assert";\nimport { x } from "../src/x.js";\ntest("x", () => assert.strictEqual(x(), 1));\n`,
    )
    await h.callTool("tdd_commit_red", { command: "node --test tests/x.test.js" })
    // attempt to edit protected test
    await expect(
      h.beforeTool("edit", { filePath: path.join(repo.dir, "tests", "x.test.js") }),
    ).rejects.toThrow(/Protected test file/)
  })

  it("rejects GREEN commit without verified green", async () => {
    await h.callTool("tdd_start", { behavior: "x" })
    await writeFile(
      path.join(repo.dir, "tests", "x.test.js"),
      `import { test } from "node:test";\nimport assert from "node:assert";\nimport { x } from "../src/x.js";\ntest("x", () => assert.strictEqual(x(), 1));\n`,
    )
    await h.callTool("tdd_commit_red", { command: "node --test tests/x.test.js" })
    await writeFile(path.join(repo.dir, "src", "x.js"), "export function x(){return 1}\n")
    // skip verify
    await expect(h.callTool("tdd_commit_green", { refactor: "no" })).rejects.toThrow(/GREEN has not been verified/)
  })
})
