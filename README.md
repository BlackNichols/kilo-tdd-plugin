# kilo-tdd-plugin

Git-backed TDD enforcement plugin for Kilo Code (VS Code extension / CLI).

Implements a RED → commit → implementation → GREEN → commit state machine enforced through Git checkpoints and Kilo plugin hooks.

## Status

**Phases 1–8 implemented (hardened), Phase 9 partially complete.** Typechecks clean. Automated tests: 56 tests across 14 files (unit + integration in temp git repos) covering happy path, correction/amend, enforcement blocks, adversarial shell/patch cases, target scoping, config loading/validation, task/MCP boundary blocking, GREEN scope policy, runner config matching, worktree config guard, and recovery reconciliation.

Core modules:
- `src/plugin.ts` — plugin entry, loads config, registers tools + `tool.execute.before` enforcement hook
- `src/tools/tdd.ts` — `tdd_start`, `tdd_status`, `tdd_commit_red`, `tdd_revert_implementation`, `tdd_amend_red`, `tdd_verify_green`, `tdd_commit_green`, `tdd_finish`
- `src/enforce/{hooks,checks}.ts` — blocks production edits in RED/correction, blocks protected test edits, blocks direct git mutations via `shell`, best-effort detection of shell file-write bypasses and unscoped patches; RED/GREEN gates and integrity checks
- `src/git/repo.ts` — safe git wrapper (`execFile`, explicit paths; no `git reset --hard`, no `git add .`)
- `src/store/store.ts` — per-session persisted cycle state (`.kilo/tdd/`), atomic writes, in-process + best-effort cross-process file lock, load-time reconciliation (fail-closed)
- `src/testrun/{adapter,runner}.ts` — test execution + heuristic verdict classification (valid RED, GREEN, compile/infra/skip/no-tests/ambiguous → rejected)
- `src/classify/classifier.ts` — file classification (production/test/test-config/protected/excluded), cwd-relative matching
- `src/types/{config,load-config,cycle,errors,state-machine}.ts` — defaults, config loading/merge, cycle models, errors, transitions

## Workflow

`tdd_commit_red`, `tdd_amend_red`, and `tdd_verify_green` accept optional `testFiles` (array) for verdict attribution/scoping; targets are also inferred from dirty/protected tests and passed to the runner/verdict classifier.

1. `tdd_start {behavior}` — requires clean git tree (excluding `.kilo/**`), no in-progress git op; records base SHA/branch.
2. Write failing test → run → `tdd_commit_red {command}` (plugin runs/verifies RED independently, stages/commits test files, records protected baseline from committed blobs).
3. Implement → `tdd_verify_green {command}` (verifies protected tests unchanged, runs tests; requires GREEN).
4. `tdd_commit_green {refactor: "yes"|"no", notes?}` — commits verified implementation files (non-protected test/config changes rejected for scope safety).
5. `tdd_finish` — generates report and clears active cycle.

**Correction:** `tdd_revert_implementation` (restores tracked impl from RED commit, removes untracked impl, explicit paths) → fix test → run → `tdd_amend_red` (re-verifies RED, amends RED commit, refreshes baseline).

## Configuration

Loaded at plugin init (first found): `kilo.json`, `kilo.jsonc`, `.kilo/config.json`. Plugin-specific settings are read from `tdd`, `pluginConfig["kilo-tdd-plugin"]`, or `"kilo-tdd-plugin"` keys and merged over defaults.

Supported overrides (validated, fail-closed on unknown keys/invalid types): `productionPatterns`, `testPatterns`, `testConfigPatterns`, `excludedPatterns`, `commitMessages` (`red`/`green`/`refactor`), `worktreeEnabled`, `refactorMandatory`, `logLevel`, `strictness`, `allowNonProtectedTestConfigInGreenCommit` (default `false`), and `testRunners` (override/inherit by `id`: `match`, `command`, `skipIndicator` regex string, `scopeArgs` prefix tokens; custom runners append target files by default).

`worktreeEnabled` defaults to `false`. **Per-cycle git worktree isolation is not implemented**; setting `worktreeEnabled: true` is rejected fail-closed at `tdd_start`.

## Verification

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest run (unit + integration)
```

## Enforcement (actual)

- `tool.execute.before` intercepts `edit`/`write`/`patch`/`apply_patch`/`shell`/`bash` during an active cycle:
  - blocks production edits in `RED_TEST` and `TEST_CORRECTION`
  - blocks edits to RED-protected test files in `IMPLEMENTATION`/`GREEN_VERIFICATION`/`REFACTOR_REVIEW`
  - blocks file modifications in commit-transition/complete states (use `tdd_*` tools)
  - blocks direct git mutations (`commit`, `merge`, `rebase`, `cherry-pick`, `reset`, `restore`, `checkout`, `switch`, `add`, `apply`, `amend`, `stash`, `clean`, `rm`, `mv`) via shell
  - **best-effort shell-write detection:** parseable redirections/`tee`/`sed -i`/`cp`/`mv` targets are classified/enforced; opaque programmatic writes (e.g. `node -e`, `python -e`, `fs.writeFile*`, heredoc writes when suspicious) are **fail-closed** in active cycle because targets cannot be proven safe
  - **patch parsing:** extracts targets from `*** Add/Update/Delete/Move to File:`, `diff --git`, and unified diff headers (`---`/`+++`); **unscoped/unparseable patches are fail-closed** in active cycle
- Integrity: protected test blob SHAs (HEAD) checked against RED baseline; on-disk content checks used where applicable. Reconciliation runs on active-cycle load.
- Git mutations by plugin use explicit file paths; never `git add .`, never `git reset --hard`, never push.

## Recovery and locking

- **Fail-closed reconciliation:** on active-cycle load, detects in-progress git operations, missing RED/GREEN commit objects, and protected-test HEAD/blob mismatches; throws requiring manual recovery (no auto-repair).
- **Crash mid-git-op:** treated as unsafe/in-progress if git reports an operation; otherwise state/commit mismatches fail closed. Automatic repair is intentionally not performed.
- **Locking:** in-process async lock per session plus best-effort cross-process lock file in `.kilo/tdd/locks/` (stale lock recovery after timeout). Not a distributed/fully robust lock.

## Known limitations (important)

- **Tool-boundary enforcement only:** hooks intercept LLM tool calls seen by this plugin. They cannot guarantee prevention of writes outside intercepted tool paths.
- **`task` subagents / MCP / alternate tool surfaces (Kilo plugin API checked: `https://kilo.ai/docs/automate/extending/plugins`, `@kilocode/plugin@1.0.25` — no `task.*`/`mcp.*`/filesystem/sandbox hooks; only tool-level interception + `shell.env`):** `task` and likely MCP/external tool names (`mcp_*`, namespaced/`__`) are **blocked fail-closed during active cycles** when routed through `tool.execute.before`. Child subagent sessions, unhooked contexts, or alternate execution paths cannot be controlled by this API — **not a provable seal**.
- **Shell write bypass residual risk (API dead-end for OS prevention):** `shell.env` cannot block commands and there are no filesystem/sandbox hooks. Parseable targets and many opaque/programmatic-write patterns are blocked/fail-closed pre-exec, but novel constructs or non-intercepted execution paths may evade detection; guaranteed prevention requires external sandboxing.
- **Patch formats:** extraction is best-effort for common formats; unknown formats without parseable targets are refused, but complex multi-file/custom formats could require further hardening.
- **Test verdicts:** heuristic but hardened (stdout/stderr/exit; node `#`/`ℹ`, TAP, JUnit/XML-ish summaries, and vitest/jest/pytest-style counts; skip/pending/todo/no-tests/infra/compile detection; missing-module-as-RED; runner match/skip-indicator hints/annotation). `tdd_*` test tools accept/infer `testFiles` for attribution and fail closed when specified targets cannot be attributed without strong structured evidence. Runner-driven command building/scoping and full JSON report ingestion are not automated yet.
- **Worktrees:** `worktreeEnabled` isolation not implemented; `true` is rejected fail-closed.
- **Config:** partial loader/merge only; no schema validation; `testRunners` not configurable.
- **GREEN commit scope:** conservative by default (rejects non-protected test/config changes in dirty set; stages implementation files excluding protected tests). Configurable via `allowNonProtectedTestConfigInGreenCommit`; atypical repos may still need pattern tuning.
- **RED commits are baseline snapshots of all dirty, non-excluded files:** `tdd_commit_red` / `tdd_amend_red` stage the full dirty set (not only intended test files) and record committed files as the protected RED baseline. Generated artifacts (e.g. Playwright `test-results/`, reports) should be excluded via `excludedPatterns` and kept out of the working tree before RED/amend, otherwise they become protected and hard to normalize in-cycle. Defaults exclude `test-results/**`, `playwright-report/**`, and `blob-report/**`; override `excludedPatterns` if your runner writes artifacts elsewhere.

## Adversarial coverage (current)

Integration tests include: dirty-start refusal, RED production-edit block, direct git mutation blocks, protected-test edit/patch blocks (including unified diff and `diff --git` targets), suspicious opaque shell-write rejection (node/python -e, heredocs, curl/wget/dd/truncate, process substitution), parseable shell redirection/cp/mv block, unscoped patch refusal, GREEN-without-verify rejection, GREEN scope policy, target scoping, config load/validation, runner config matching, task/MCP boundary blocking, persisted protected-test tamper and missing RED commit fail-closed reconciliation, in-progress git-op fail-closed, and per-session cycle isolation. Not fully covered: unhooked subagent/MCP execution paths, all shell escape forms, restart-during-commit automation, true cross-process contention stress, and runner-specific structured parsing/auto-scoped command building.

## License

MIT
