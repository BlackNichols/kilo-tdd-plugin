import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { makeTempRepo } from "../helpers/repo"
import { createHarness } from "../helpers/harness"

describe("git global option bypass attempts", () => {
  let repo: Awaited<ReturnType<typeof makeTempRepo>>
  let h: ReturnType<typeof createHarness>

  beforeEach(async () => { repo = await makeTempRepo(); h = createHarness(repo.dir) })
  afterEach(async () => { await repo.cleanup() })

  it("blocks git mutations with -C and --git-dir/--work-tree", async () => {
    await h.callTool("tdd_start", { behavior: "x" })
    await expect(h.beforeTool("bash", { command: `git -C ${repo.dir} commit -m x` })).rejects.toThrow(/Direct git mutation is blocked/)
    await expect(h.beforeTool("bash", { command: "git --no-pager add -A" })).rejects.toThrow(/Direct git mutation is blocked/)
  })
})
