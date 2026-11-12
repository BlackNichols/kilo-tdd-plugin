/**
 * Runtime configuration for the TDD plugin.
 *
 * All fields are read-only after the plugin loads. Tests construct
 * `TddConfig` objects directly and pass them in, so the defaults live here
 * as a single source of truth.
 */
export interface TddConfig {
  /** Glob patterns identifying production (non-test) files. */
  readonly productionPatterns: readonly string[]
  /** Glob patterns identifying test files. */
  readonly testPatterns: readonly string[]
  /** Glob patterns identifying test configuration files. */
  readonly testConfigPatterns: readonly string[]
  /** Files and directories excluded from all TDD classification. */
  readonly excludedPatterns: readonly string[]
  /** Supported test runners, in priority order. */
  readonly testRunners: readonly TestRunnerConfig[]
  /** Git commit message templates. */
  readonly commitMessages: CommitMessages
  /** Whether each cycle runs in a dedicated Git worktree. */
  readonly worktreeEnabled: boolean
  /** Whether the refactoring review step is mandatory. */
  readonly refactorMandatory: boolean
  /** Logging verbosity. */
  readonly logLevel: "debug" | "info" | "warn" | "error"
  /** Enforcement strictness. When "strict" the plugin refuses ambiguous results. */
  readonly strictness: "strict" | "lenient"
  /** Allow committing non-protected test/config changes in GREEN commit (default false; keeps scope strict). */
  readonly allowNonProtectedTestConfigInGreenCommit: boolean
}

export interface TestRunnerConfig {
  /** Identifier, e.g. "vitest", "jest", "pytest". */
  readonly id: string
  /** Command prefix that identifies this runner when the agent runs it. */
  readonly match: string[]
  /** How to scope a run to specific test files. */
  readonly scopeArgs: (files: readonly string[]) => readonly string[]
  /**
   * Base command used for runner-driven command building when enabled.
   * When `buildCommand` is true and target tests are provided, the executed command becomes
   * `baseCommand` + `scopeArgs(targetTests)` (shell-quoted) instead of the caller's raw command.
   */
  readonly command?: string
  /** When true, build a scoped command from `command`/`scopeArgs` for targeted runs. */
  readonly buildCommand?: boolean
  /** Structured report ingestion. "auto" tries known formats for the runner id. */
  readonly reportFormat?: "json" | "junit" | "auto"
  /**
   * Extra args to enable report output. May include `{file}` placeholder for report path.
   * If omitted and `reportFormat` is set, runner-specific defaults are used when known.
   */
  readonly reportArgs?: readonly string[]
  /** Regex that identifies a skipped test in structured output. */
  readonly skipIndicator?: RegExp
}

export interface CommitMessages {
  readonly red: string
  readonly green: string
  readonly refactor: string
}

/** Sensible defaults for a fresh repository. */
export const DEFAULT_CONFIG: TddConfig = {
  productionPatterns: ["src/**", "lib/**", "app/**", "packages/*/src/**"],
  testPatterns: [
    "test/**",
    "tests/**",
    "**/*.test.ts",
    "**/*.spec.ts",
    "**/*.test.js",
    "**/*.spec.js",
    "**/*_test.go",
    "**/*_test.py",
    "**/*.test.tsx",
    "**/*.spec.tsx",
  ],
  testConfigPatterns: [
    "**/vitest.config.*",
    "**/jest.config.*",
    "**/pytest.ini",
    "**/pyproject.toml",
    "**/tox.ini",
    "**/go.mod",
    "**/Cargo.toml",
    "**/tsconfig*.json",
    "**/package.json",
    "**/setup.cfg",
  ],
  excludedPatterns: [
    "node_modules/**",
    ".git/**",
    "dist/**",
    "build/**",
    ".kilo/**",
    "coverage/**",
    "test-results/**",
    "playwright-report/**",
    "blob-report/**",
  ],
  testRunners: [
    {
      id: "vitest",
      match: ["vitest", "vite"],
      command: "vitest",
      buildCommand: false,
      scopeArgs: (files) => ["run", ...files],
      reportFormat: "auto",
      skipIndicator: /\[skip\]|Skipped|✓.*skip/i,
    },
    {
      id: "jest",
      match: ["jest"],
      command: "jest",
      buildCommand: false,
      scopeArgs: (files) => ["--runInBand", ...files],
      reportFormat: "auto",
      skipIndicator: /\bskip\b|Skipped/i,
    },
    {
      id: "pytest",
      match: ["pytest"],
      command: "pytest",
      buildCommand: false,
      scopeArgs: (files) => ["-q", ...files],
      reportFormat: "auto",
      skipIndicator: /\bskipped\b|SKIPPED/i,
    },
    {
      id: "cargo",
      match: ["cargo test"],
      command: "cargo test",
      buildCommand: false,
      scopeArgs: (files) => [...files],
      reportFormat: "auto",
      skipIndicator: /test result: ok.*0 tests/i,
    },
    {
      id: "go",
      match: ["go test"],
      command: "go test",
      buildCommand: false,
      scopeArgs: (files) => ["./...", ...files],
      reportFormat: "auto",
      skipIndicator: /\(-skip\)|SKIP/i,
    },
    {
      id: "npm",
      match: ["npm test"],
      scopeArgs: () => [],
      reportFormat: "auto",
      skipIndicator: /skip|passing.*failing/i,
    },
  ],
  commitMessages: {
    red: "test: add failing test for {behavior}",
    green: "fix: implement {behavior}",
    refactor: "refactor: {behavior}",
  },
  worktreeEnabled: false,
  refactorMandatory: true,
  logLevel: "info",
  strictness: "strict",
  allowNonProtectedTestConfigInGreenCommit: false,
}
