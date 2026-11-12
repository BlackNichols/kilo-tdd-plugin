import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { writeFile } from "node:fs/promises"
import path from "node:path"
import { makeTempRepo, git } from "../helpers/repo"
import { createHarness } from "../helpers/harness"

describe("more adversarial cases", () => {
  let repo: Awaited<ReturnType<typeof makeTempRepo>>
  let h: ReturnType<typeof createHarness>

  beforeEach(async () => {
    repo = await makeTempRepo()
    h = createHarness(repo.dir)
  })

  afterEach(async () => { await repo.cleanup() })

  async function startWithRed() {
    await h.callTool("tdd_start", { behavior: "x" })
    await writeFile(
      path.join(repo.dir, "tests", "x.test.js"),
      `import { test } from "node:test";\nimport assert from "node:assert";\nimport { x } from "../src/x.js";\ntest("x", () => assert.strictEqual(x(), 1));\n`,
    )
    await h.callTool("tdd_commit_red", { command: "node --test tests/x.test.js" })
  }

  it("blocks git commit -a and git add variants", async () => {
    await h.callTool("tdd_start", { behavior: "x" })
    await expect(h.beforeTool("shell", { command: "git commit -am 'x'" })).rejects.toThrow(/Direct git mutation is blocked/)
    await expect(h.beforeTool("shell", { command: "git add -A" })).rejects.toThrow(/Direct git mutation is blocked/)
  })

  it("blocks parseable shell write to protected test in implementation", async () => {
    await startWithRed()
    await expect(h.beforeTool("bash", { command: "echo '// tamper' >> tests/x.test.js" })).rejects.toThrow(/Protected test file/)
  })

  it("blocks *** Update File patch targeting protected test", async () => {
    await startWithRed()
    const patch = `*** Update File: tests/x.test.js\n@@\n-old\n+new\n`
    await expect(h.beforeTool("patch", { patchText: patch })).rejects.toThrow(/Protected test file/)
  })

  it("blocks namespaced MCP-style tool during active cycle", async () => {
    await h.callTool("tdd_start", { behavior: "x" })
    await expect(h.beforeTool("server__write_file", { path: "src/x.ts" })).rejects.toThrow(/MCP\/external tools/)
  })
})
