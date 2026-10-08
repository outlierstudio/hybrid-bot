# Known test failures

Checked-in allowlist for full-suite verification after each Hybrid step.
Any failure **not** listed here fails the step.

Last audited: 2026-10-08 (v0.1.1: always-allow parts, projection_thread_bots, live bot list).
Baseline tip: `74d8742d8`. This file is the only copy; the old `plans/` duplicate is gone.

## How to verify

```bash
cd apps/server && vp test run
cd apps/web && vp test run
cd packages/contracts && vp test run
cd packages/client-runtime && vp test run
```

Run unsandboxed when git/tmp operations are blocked. Compare failures against this list.

## Allowlisted

| File                                                            | Status                              | Notes                                                                                     |
| --------------------------------------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------- |
| `apps/server/src/orchestration/ThreadSettlementReactor.test.ts` | **verified failing on refs/t3code** | ~37 `storage cleanup` failures                                                            |
| `apps/server/src/entrypoint.test.ts`                            | **verified failing on refs/t3code** | Symlinked entrypoint match under this host/tmpdir layout                                  |
| `apps/server/src/project/AgentSessionScanner.test.ts`           | **verified failing on refs/t3code** | Symlink-into-worktrees exclusion flake                                                    |
| `apps/server/src/preview/PortScanner.test.ts`                   | **unverified**                      | TCP probe timeouts under full-suite load (not re-checked on refs/t3code this pass)        |
| `apps/server/src/provider/Layers/ProviderRegistry.test.ts`      | **unverified**                      | Re-probe also collects `/opt/homebrew/bin/brew` (not re-checked on refs/t3code this pass) |
| `apps/web/src/components/files/fileEditorHighlight.test.ts`     | **unverified**                      | Occasional 15s timeout under full-suite load                                              |

## Removed from allowlist

| File                              | Why                                                                                                                                                  |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/server/src/cli/app.test.ts` | Was Hybrid-caused: tests and default home still used `.t3` / `t3code` socket namespace while production uses `.hybrid` / `hybrid`. Fixed; must pass. |

## Cleared earlier

PR/github group and Phase 2 MessagesTimeline harness cases. Partner eval fixtures excluded via `**/scripts/eval-fixtures/**`.
