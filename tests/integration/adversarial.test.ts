import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { writeFile, readFile } from "node:fs/promises"
import path from "node:path"
import { makeTempRepo, git } from "../helpers/repo"
import { createHarness } from "../helpers/harness"

describe("adversarial enforcement", () => {
  let repo: Awaited<ReturnType<typeof makeTempRepo>>
  let h: ReturnType<typeof createHarness>

  beforeEach(async () => {
    repo = await makeTempRepo()
    h = createHarness(repo.dir)
  })

  afterEach(async () => {
    await repo.cleanup()
  })

  async function startWithRed() {
    await h.callTool("tdd_start", { behavior: "x" })
    await writeFile(
      path.join(repo.dir, "tests", "x.test.js"),
      `import { test } from "node:test";\nimport assert from "node:assert";\nimport { x } from "../src/x.js";\ntest("x", () => assert.strictEqual(x(), 1));\n`,
    )
    await h.callTool("tdd_commit_red", { command: "node --test tests/x.test.js" })
  }

  it("blocks suspicious programmatic shell writes in RED_TEST", async () => {
    await h.callTool("tdd_start", { behavior: "x" })
    await expect(
      h.beforeTool("shell", { command: `node -e "require('fs').writeFileSync('src/x.js','x')"` }),
    ).rejects.toThrow(/programmatic file writes|TDD enforcement/)
  })

  it("blocks shell redirection to production file in RED_TEST when target parseable", async () => {
    await h.callTool("tdd_start", { behavior: "x" })
    await expect(
      h.beforeTool("shell", { command: "echo export const x=1 > src/x.js" }),
    ).rejects.toThrow(/Production modifications are blocked/)
  })

  it("blocks git reset/checkout variants via shell", async () => {
    await h.callTool("tdd_start", { behavior: "x" })
    await expect(h.beforeTool("bash", { command: "git reset --hard HEAD~1" })).rejects.toThrow(/Direct git mutation is blocked/)
    await expect(h.beforeTool("bash", { command: "git checkout -- src/foo.ts" })).rejects.toThrow(/Direct git mutation is blocked/)
    await expect(h.beforeTool("bash", { command: "git stash" })).rejects.toThrow(/Direct git mutation is blocked/)
  })

  it("fails closed on unscoped patch in active cycle", async () => {
    await h.callTool("tdd_start", { behavior: "x" })
    await expect(
      h.beforeTool("patch", { patchText: "some opaque patch format without file headers" }),
    ).rejects.toThrow(/Cannot determine target files/)
  })

  it("blocks patch targeting protected test after RED commit", async () => {
    await startWithRed()
    await expect(
      h.beforeTool("apply_patch", { patchText: `--- a/tests/x.test.js\n+++ b/tests/x.test.js\n@@ -1 +1 @@\n-old\n+new\n` }),
    ).rejects.toThrow(/Protected test file/)
  })

  it("rejects tdd_commit_green when non-protected test/config changes exist", async () => {
    await startWithRed()
    await writeFile(path.join(repo.dir, "src", "x.js"), "export function x(){return 1}\n")
    await h.callTool("tdd_verify_green", { command: "node --test tests/x.test.js" })
    // introduce unrelated test config change
    await writeFile(path.join(repo.dir, "vitest.config.ts"), "export default {}\n")
    await expect(h.callTool("tdd_commit_green", { refactor: "no" })).rejects.toThrow(/Non-protected test\/config files changed|No implementation files/)
  })

  it("fails closed on persisted HEAD tamper of protected test", async () => {
    await startWithRed()
    // tamper committed protected test directly in git (simulate bypass outside hook)
    await writeFile(
      path.join(repo.dir, "tests", "x.test.js"),
      `import { test } from "node:test";\nimport assert from "node:assert";\ntest("tampered", () => assert.ok(true));\n`,
    )
    await git(repo.dir, ["add", "tests/x.test.js"])
    await git(repo.dir, ["commit", "-m", "tamper"])
    // reload -> reconciliation should detect HEAD blob mismatch
    const h2 = createHarness(repo.dir, h.sessionID)
    await expect(h2.store.getActive(h.sessionID)).rejects.toThrow(/does not match recorded RED baseline|inconsistent|Manual recovery/)
  })

  it("does not block read-only git commands in shell", async () => {
    await h.callTool("tdd_start", { behavior: "x" })
    await expect(h.beforeTool("shell", { command: "git status --porcelain" })).resolves.toBeDefined()
    await expect(h.beforeTool("shell", { command: "git log -1 --oneline" })).resolves.toBeDefined()
  })
})
