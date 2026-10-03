# Deployment fixture test runner reliability

## Evidence and limits

This change is test infrastructure only; the deploy workflow, production scripts, compose files,
and product code are unchanged. Deployment fixtures use temporary directories, mocked Docker,
and (for authentication) real Git against the existing local HTTP mock on an ephemeral port.
No production credentials, API, database, Slack, or real Docker deployment is needed.

On baseline `c7acd09`, the deployment-only suite passed both locally:

| Command | Result | Vitest duration | Shell wall time |
| --- | --- | --- | --- |
| `yarn workspace shookie test src/deployment --testTimeout=20000 --maxWorkers=1` | exit 0, 58 tests / 4 files | 62.10s | 63s |
| `yarn workspace shookie test src/deployment` | exit 0, 58 tests / 4 files | 47.52s | 48s |

Environment: Darwin 25.5.0 arm64, 11 logical CPUs, non-root UID 501, Node 24.14.0,
Yarn 4.5.3, Vitest 3.2.7, Python 3.14.6, Git 2.53.0. No test-related environment overrides
were added; `GIT_BIN` was not overridden. The host was not reserved exclusively, so these
numbers are observations, not performance benchmarks.

The previously reported full-suite `[vitest-worker]: Timeout calling onTaskUpdate` failure
was **not reproduced by these baseline deployment-only runs**. This does not establish that
all RPC failures have the same cause. The blocking mechanism itself is reproducible:
a 400ms shell invocation allowed zero 10ms interval callbacks with `spawnSync`, versus 39
with `spawn`. The regression test also compares the former synchronous behavior with
`runBash` while the same timer is active. Long synchronous invocations prevent Vitest's
worker from servicing timers/messages, even if all script assertions eventually pass.

One baseline rollback case took 5.011s with the 20s test-timeout flag, demonstrating that
the default 5s limit is too close to actual multi-step fixture work on this host. No speedup
is claimed; asynchronous execution keeps the worker responsive while subprocesses run.

## Runner contract

- `runBash` and all Git / image-verification fixture invocations are awaited async children.
- Each command defaults to a **15s child timeout** and **1 MiB combined stdout/stderr cap**.
  Test-only options can reduce these bounds for lifecycle regressions.
- Successful execution waits for `close` (process exit plus stdout/stderr closure), returns
  `status`, `signal`, `stdout`, `stderr`, and the existing stdout-then-stderr `output` field.
  A script's nonzero exit remains a normal result for deployment failure assertions.
- Spawn errors, timeout, excess output, and teardown cancellation reject with bounded,
  labeled stdout/stderr diagnostics. They cannot pass a `status !== 0` deployment assertion
  merely because the runner failed. Diagnostics may contain fixture output: never use this
  helper with real credentials.
- Children are detached POSIX process groups. Timeout/output/teardown sends group SIGTERM,
  then SIGKILL after 250ms **even if the shell has already exited**, and waits for closure.
  This covers shell descendants that ignore TERM; intentionally escaping the process group
  is not supported. These Bash/Python fixtures target macOS/Linux, not Windows.
- `cleanupCommands()` runs in fixture `afterEach` before deleting files. The Git HTTP server
  also runs in its own group and is terminated/reaped before its sandbox is removed,
  including startup failure and already-exited cases.
- Deploy-script and Git-auth suites alone have a **30s per-test budget**; Git-auth setup has
  a 30s hook budget. They perform multiple local commands (up to five deployment runs in
  one history case), so the test budget is distinct from the per-child bound. Other tests
  keep Vitest's default limit; no global timeout, retry, RPC-error suppression, or exclusion
  is introduced. The pre-existing root-only read-only-file skip remains unchanged.

Regressions cover event-loop progress, complete output/env/cwd/nonzero status, bounded
output, timeout and TERM-resistant descendants, teardown cancellation, spawn failures,
already-closed server teardown, and invalid bounds. An initial regression run exposed
macOS `/var` versus `/private/var` canonicalization in its new cwd assertion; it was fixed
using `realpathSync`, not by weakening the assertion. All 58 pre-existing deployment cases
passed in that run.

## Validation and durable logs

Build the workspace dependency before the bot when using a fresh checkout:

```bash
yarn workspace database build
yarn workspace shookie build
yarn workspace shookie test src/deployment --maxWorkers=1
yarn workspace shookie test --maxWorkers=1
```

The final command includes **every test file**, with one worker to bound fixture resource
contention. It does not set a global timeout. Final tested SHA, exact exit codes, durations,
and log locations are recorded in the PR validation report, rather than inferring success
from assertion totals alone.

For an observation window shorter than the suite, start the command in the background
with durable logs and an exit record; do not terminate it just because a tool's observation
window expires. Example (replace `/tmp/shookie-test-check` with a unique directory):

```bash
mkdir -p /tmp/shookie-test-check
(
  start=$(date +%s)
  yarn workspace shookie test --maxWorkers=1 > /tmp/shookie-test-check/full.log 2>&1
  code=$?
  printf 'exit=%s duration_seconds=%s\n' "$code" "$(( $(date +%s)-start ))" \
    > /tmp/shookie-test-check/full.exit
) < /dev/null > /tmp/shookie-test-check/launch.log 2>&1 &
```

Inspect the completion record and complete log after a reasonable wait. Exit 0 and no
unhandled runner errors are required; counts alone are insufficient. Validation cannot
prove behavior under arbitrary host contention or diagnose the original other-branch RPC
incident conclusively.
