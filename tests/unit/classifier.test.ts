import { describe, it, expect } from "vitest"
import { createClassifier } from "../../src/classify/classifier"
import { DEFAULT_CONFIG } from "../../src/types/config"

describe("file classifier", () => {
  const c = createClassifier(
    DEFAULT_CONFIG.productionPatterns,
    DEFAULT_CONFIG.testPatterns,
    DEFAULT_CONFIG.testConfigPatterns,
    DEFAULT_CONFIG.excludedPatterns,
  )

  it("classifies src files as production", () => {
    expect(c.isProduction("src/foo.ts")).toBe(true)
  })

  it("classifies test files as test", () => {
    expect(c.isTest("tests/foo.test.ts")).toBe(true)
    expect(c.isTest("src/foo.test.ts")).toBe(true)
  })

  it("classifies config files", () => {
    expect(c.isTestConfig("vitest.config.ts")).toBe(true)
  })

  it("excludes common generated test artifacts by default", () => {
    expect(c.isExcluded("test-results/.last-run.json")).toBe(true)
    expect(c.isExcluded("playwright-report/index.html")).toBe(true)
    expect(c.isExcluded("blob-report/report.zip")).toBe(true)
  })

  it("respects protected set", () => {
    const prot = new Set(["tests/foo.test.ts"])
    expect(c.isProtected("tests/foo.test.ts", prot)).toBe(true)
    expect(c.isProtected("tests/bar.test.ts", prot)).toBe(false)
  })
})
