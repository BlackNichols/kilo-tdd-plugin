/**
 * File classification.
 *
 * Every file touched during a cycle is classified into exactly one bucket.
 * Classification is based on glob patterns from the config plus, for the
 * RED commit, the actual set of files recorded in that commit.
 *
 * We deliberately do NOT trust the agent's claim about what a file is. The
 * plugin re-classifies every path itself.
 */
// @ts-ignore - no types available
import micromatch from "micromatch"

export enum FileClass {
  /** A file that was committed in the RED checkpoint. */
  PROTECTED_TEST = "PROTECTED_TEST",
  /** A file matching the test-file patterns but not committed in RED. */
  TEST = "TEST",
  /** A file matching the test-configuration patterns. */
  TEST_CONFIG = "TEST_CONFIG",
  /** A file matching the production patterns. */
  PRODUCTION = "PRODUCTION",
  /** A file that matches none of the above. */
  OTHER = "OTHER",
}

export interface FileClassifier {
  classify(absPath: string, protectedTestFiles?: ReadonlySet<string>): FileClass
  isTest(absPath: string): boolean
  isProduction(absPath: string): boolean
  isTestConfig(absPath: string): boolean
  isProtected(absPath: string, protectedTestFiles?: ReadonlySet<string>): boolean
  isExcluded(absPath: string): boolean
}

export function createClassifier(
  productionPatterns: readonly string[],
  testPatterns: readonly string[],
  testConfigPatterns: readonly string[],
  excludedPatterns: readonly string[],
  cwd?: string,
): FileClassifier {
  const norm = (p: string) => p.replace(/\\/g, "/")
  const rel = (p: string) => {
    const n = norm(p)
    if (!cwd) return n
    const base = norm(cwd).replace(/\/+$/, "") + "/"
    if (n.startsWith(base)) return n.slice(base.length)
    return n
  }

  const isExcluded = (absPath: string): boolean => {
    const p = rel(absPath)
    return micromatch.isMatch(p, [...excludedPatterns, "**/node_modules/**", "**/.git/**"], { dot: true })
  }

  const isTest = (absPath: string): boolean => {
    const p = rel(absPath)
    return micromatch.isMatch(p, testPatterns)
  }

  const isProduction = (absPath: string): boolean => {
    const p = rel(absPath)
    return micromatch.isMatch(p, productionPatterns)
  }

  const isTestConfig = (absPath: string): boolean => {
    const p = rel(absPath)
    return micromatch.isMatch(p, testConfigPatterns)
  }

  const isProtected = (absPath: string, protectedTestFiles?: ReadonlySet<string>): boolean => {
    if (!protectedTestFiles) return false
    const p = rel(absPath)
    for (const f of protectedTestFiles) {
      const rf = rel(f)
      if (rf === p || norm(f) === norm(absPath)) return true
    }
    return false
  }

  const classify = (
    absPath: string,
    protectedTestFiles?: ReadonlySet<string>,
  ): FileClass => {
    if (isExcluded(absPath)) return FileClass.OTHER
    if (isProtected(absPath, protectedTestFiles)) return FileClass.PROTECTED_TEST
    if (isTestConfig(absPath)) return FileClass.TEST_CONFIG
    if (isTest(absPath)) return FileClass.TEST
    if (isProduction(absPath)) return FileClass.PRODUCTION
    return FileClass.OTHER
  }

  return {
    classify,
    isTest,
    isProduction,
    isTestConfig,
    isProtected,
    isExcluded,
  }
}