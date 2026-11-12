import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { writeFile } from "node:fs/promises"
import path from "node:path"
import { makeTempRepo } from "../helpers/repo"
import { createHarness } from "../helpers/harness"

describe("adversarial shell/patch cases", () => {
  let repo: Awaited<ReturnType<typeof makeTempRepo>>
  let h: ReturnType<typeof createHarness>

  beforeEach(async () => {
    repo = await makeTempRepo()
    h = createHarness(repo.dir)
  })

  afterEach(async () => {
    await repo.cleanup()
  })

  it("blocks python -c and heredoc-style opaque writes in RED_TEST", async () => {
    await h.callTool("tdd_start", { behavior: "x" })
    await expect(h.beforeTool("shell", { command: `python3 -c "open('src/x.js','w').write('x')"` })).rejects.toThrow(/programmatic file writes|TDD enforcement/)
    await expect(h.beforeTool("shell", { command: `cat <<'EOF' > src/x.js\nx\nEOF` })).rejects.toThrow(/TDD enforcement/)
  })

  it("blocks curl/wget output and dd/truncate suspicious writes", async () => {
    await h.callTool("tdd_start", { behavior: "x" })
    await expect(h.beforeTool("bash", { command: "curl http://example.invalid -o src/x.js" })).rejects.toThrow(/TDD enforcement/)
    await expect(h.beforeTool("bash", { command: "dd if=/dev/null of=src/x.js" })).rejects.toThrow(/TDD enforcement/)
  })

  it("blocks cp/mv to production paths when parseable in RED_TEST", async () => {
    await h.callTool("tdd_start", { behavior: "x" })
    await expect(h.beforeTool("shell", { command: "cp tests/x.test.js src/x.js" })).rejects.toThrow(/Production modifications are blocked/)
  })

  it("fails closed on patch without recognizable file headers", async () => {
    await h.callTool("tdd_start", { behavior: "x" })
    await expect(h.beforeTool("patch", { diff: "not a diff" })).rejects.toThrow(/Cannot determine target files/)
  })

  it("accepts parseable unified diff and enforces RED_TEST production block", async () => {
    await h.callTool("tdd_start", { behavior: "x" })
    const patch = `--- a/src/x.js\n+++ b/src/x.js\n@@ -0,0 +1 @@\n+export const x=1\n`
    await expect(h.beforeTool("patch", { patchText: patch })).rejects.toThrow(/Production modifications are blocked/)
  })

  it("extracts targets from diff --git patches and enforces RED_TEST production block", async () => {
    await h.callTool("tdd_start", { behavior: "x" })
    const patch = `diff --git a/src/x.js b/src/x.js\nnew file mode 100644\nindex 0000000..e69de29\n--- /dev/null\n+++ b/src/x.js\n@@ -0,0 +1 @@\n+export const x=1\n`
    await expect(h.beforeTool("patch", { patchText: patch })).rejects.toThrow(/Production modifications are blocked/)
  })

  it("blocks process substitution shell writes as suspicious in active cycle", async () => {
    await h.callTool("tdd_start", { behavior: "x" })
    await expect(h.beforeTool("bash", { command: "cat > >(tee src/x.js) <<< 'x'" })).rejects.toThrow(/programmatic file writes|Production modifications are blocked|TDD enforcement/)
  })
})
