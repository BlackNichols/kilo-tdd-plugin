import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { makeTempRepo } from "../helpers/repo"
import { createHarness } from "../helpers/harness"
import { DEFAULT_CONFIG } from "../../src/types/config"

describe("worktreeEnabled", () => {
  let repo: Awaited<ReturnType<typeof makeTempRepo>>

  beforeEach(async () => { repo = await makeTempRepo() })
  afterEach(async () => { await repo.cleanup() })

  it("fails closed when worktreeEnabled is true (not implemented)", async () => {
    const h = createHarness(repo.dir, "ses_test", { ...DEFAULT_CONFIG, worktreeEnabled: true })
    await expect(h.callTool("tdd_start", { behavior: "x" })).rejects.toThrow(/worktreeEnabled is not implemented/)
  })
})
