import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { writeFile } from "node:fs/promises"
import path from "node:path"
import { makeTempRepo } from "../helpers/repo"
import { createHarness } from "../helpers/harness"
import { DEFAULT_CONFIG } from "../../src/types/config"

describe("GREEN commit scope policy", () => {
  let repo: Awaited<ReturnType<typeof makeTempRepo>>

  beforeEach(async () => {
    repo = await makeTempRepo()
  })

  afterEach(async () => {
    await repo.cleanup()
  })

  async function reachGreen(h: ReturnType<typeof createHarness>) {
    await h.callTool("tdd_start", { behavior: "x" })
    await writeFile(
      path.join(repo.dir, "tests", "x.test.js"),
      `import { test } from "node:test";\nimport assert from "node:assert";\nimport { x } from "../src/x.js";\ntest("x", () => assert.strictEqual(x(), 1));\n`,
    )
    await h.callTool("tdd_commit_red", { command: "node --test tests/x.test.js" })
    await writeFile(path.join(repo.dir, "src", "x.js"), "export function x(){return 1}\n")
    await h.callTool("tdd_verify_green", { command: "node --test tests/x.test.js" })
  }

  it("rejects non-protected test/config changes by default", async () => {
    const h = createHarness(repo.dir)
    await reachGreen(h)
    await writeFile(path.join(repo.dir, "vitest.config.ts"), "export default {}\n")
    await expect(h.callTool("tdd_commit_green", { refactor: "no" })).rejects.toThrow(/Non-protected test\/config files changed/)
  })

  it("allows non-protected test/config changes when configured", async () => {
    const h = createHarness(repo.dir, "ses_test", { ...DEFAULT_CONFIG, allowNonProtectedTestConfigInGreenCommit: true })
    await reachGreen(h)
    await writeFile(path.join(repo.dir, "vitest.config.ts"), "export default {}\n")
    await expect(h.callTool("tdd_commit_green", { refactor: "no" })).resolves.toMatch(/GREEN committed/)
  })
})
