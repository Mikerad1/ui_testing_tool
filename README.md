# UI Memory Browser

A local TypeScript CLI that serves browser and durable knowledge tools over authenticated MCP Streamable HTTP. Requires Node.js 20+ and the locally installed Playwright browser binary selected by configuration (Chromium by default).

```sh
npm install
npx playwright install chromium
npm run build
npm link
umb init --project demo --url http://127.0.0.1:3000
$env:UMB_MCP_TOKEN = 'use-a-long-random-secret' # PowerShell; use export on POSIX
umb doctor
umb serve
```

Connect an MCP client to `http://127.0.0.1:7317/mcp` with `Authorization: Bearer <token>`. For a local subprocess MCP transport instead, run `umb mcp --stdio --config ./umb.config.yaml`; the parent MCP client launches UMB and communicates over stdin/stdout (stdout carries protocol messages only). `umb init` refuses to overwrite existing configuration. Set `server.auth.mode: none` only for explicitly trusted loopback development; it emits a warning. Target page origins are restricted to the configured base URL and `browser.allowed_origins`; each redirect hop is checked before it loads. Upload paths and screenshot artifacts are confined to the project root; screenshots mask form fields by default. Knowledge is validated as a complete tree before transactional upsert; YAML-owned removals become tombstones and agent knowledge is preserved.

MCP provides browser status, navigation, popup-aware tab management, interactive/compact/full snapshots, semantic locators, click/fill/type/press/keyboard/select/scroll/wait, file upload, screenshot, back/forward, and project/browser/screen/workflow resources. The read-only `browser_errors` tool returns bounded diagnostic metadata when enabled. Tool responses include structured success/error envelopes. Memory context/search/get/propose/verify/export, graph edges/neighbors/path/conflicts/stats, deterministic `test_assert`, and `test_report` are available. Assertion outcomes and evidence are project-scoped in SQLite; failure screenshots mask form fields and report metadata omits input values. No raw SQL or page JavaScript interface is exposed. Never place credentials in knowledge YAML.

Browser diagnostics are disabled by default. To opt in, set one or more of `browser.diagnostics.console_errors`, `page_errors`, `failed_requests`, or `http_errors` to `true`; `browser.diagnostics.capacity` bounds the in-memory event buffer (1–1000, default 100). Events expose only safe metadata and an allowlisted origin; raw messages, URL paths/queries, headers, bodies, cookies, and form values are not captured or persisted. `browser_errors` supports cursor-based reads of the current process buffer.

`umb serve` and `umb mcp --stdio` hold an exclusive project lock under `.umb/locks` and a database lock adjacent to the canonical DB path before opening or mutating state; this also serializes overlapping project roots that resolve to the same DB. Stale same-host dead-PID locks are reclaimed under a per-lock exclusive gate; orphaned/malformed/remote-owner recovery gates fail closed and may need manual cleanup after verifying no owner is active. `umb doctor` is read-only: it validates YAML/config, checks an existing DB without migration, checks auth/port settings, and launches an ephemeral Chromium page without navigating to the application. The process owns one shared browser page and grants one MCP session a single-writer lease at a time. A second initializer receives HTTP 409 until the active session closes or expires after five minutes without requests. Browser tool operations are serialized within that lease; callers can use `expected_revision` to reject stale mutations. The idle timeout is injectable through the server API for tests. Shutdown drains MCP work before closing resources.

## Workflow replay and recall

For explicit Playwright client attachment, set `UMB_PLAYWRIGHT_ENDPOINT_TOKEN` to a random secret of at least 32 bytes and run `umb playwright endpoint --config ./umb.config.yaml`; copy the printed loopback WebSocket URL into the trusted client and supply `Authorization: Bearer <token>` (Playwright `chromium.connect` headers). The URL is not authentication; the bearer token is required. The endpoint owns its launched browser and holds the project lock until shutdown. Optional CDP attachment is deferred.

This endpoint starts a separate Playwright `BrowserServer` for the external Playwright client. It is not the `BrowserController` page or context used by `umb serve` or `umb mcp --stdio`; the project lock prevents those UMB modes from running concurrently for the same project, and the endpoint proxy permits only one external WebSocket client at a time.

`test_run_workflow` executes only YAML-authored, strictly validated workflows. Call it with `workflow_id`, optional role/environment context, and the current `expected_revision`. Role/environment are applicability context, not authorization credentials. Environment values resolve only from declared whole-field `${{ variables.NAME }}` references, remain in memory, and are omitted from run reports. Preconditions run before browser mutations; retries are limited to bounded wait steps. Matching configured high-risk target actions still prompt for a separate local TTY approval on each action.

`memory_recall` is read-only: it derives the current route from the active browser and returns up to three YAML-authored workflow recommendations with safe action summaries, directed route paths, evidence/run citations, and explicit uncertainty. It omits payload values, expected text, raw locator payloads, page content, and URL query data. Recall never executes a workflow or bypasses its preconditions/approvals.

## Reviewed workflow spec export (P2A)

After a workflow has a successful project-scoped `test_run_workflow` run, explicitly verify that run from a local interactive TTY, then export the current hash-bound YAML revision:

```sh
umb workflow verify <workflow-id> --run-id <run-id> --config ./umb.config.yaml
umb workflow export <workflow-id> --output specs/<name>.spec.ts --config ./umb.config.yaml
npx tsx --test specs/<name>.spec.ts
```

Export only writes a new file; it never runs the generated test. Review generated source before running it. Environment references become runtime `process.env` lookups and resolved values are not embedded. Static literal values in YAML, including any sensitive literals, are copied into generated source; use declared environment references for sensitive data. Verification is bound to a deterministic fingerprint of every active YAML source path and hash in the project, including screen/element locator and route data. Any active YAML edit conservatively requires a new successful workflow run and local verification. Generated specs select an engine with `UMB_PLAYWRIGHT_ENGINE` (default `chromium`); unknown engines fail.

When a workflow's primary locator is stale or ambiguous, UMB may record a proposal if an authored fallback is uniquely visible; it never executes that fallback. Stop `umb serve` before using `umb knowledge proposals` or `umb knowledge confirm-locator <proposal-id>` because these local CLI commands require the project lock. Review the escaped prior/candidate locators, manually edit the source YAML to make the candidate primary while preserving the old locator in `fallback_locators`, then confirm from an interactive TTY. UMB validates and reconciles the full knowledge tree before marking the proposal accepted. Pending/rejected candidates remain non-executable, including after a later reload.

`umb knowledge validate` checks the complete YAML tree without database changes. Stop `umb serve` before running `umb knowledge reload --config ./umb.config.yaml`; reload takes the project lock and applies the same complete validation/transactional reconcile used at startup. For live refreshes, start the server with `umb serve --watch-knowledge`; filesystem events are debounced hints for a full-tree reconcile, serialized with workflow runs. Invalid YAML leaves the last valid graph active, and shutdown drains the watcher before closing Store/locks.

## Browser engine selection (P2B)

Chromium remains the default. Set the strict `browser.engine` value to `chromium`, `firefox`, or `webkit` to select an engine for `umb serve`, stdio mode, `umb playwright endpoint`, and `umb doctor`:

```yaml
browser:
  engine: firefox # chromium (default), firefox, or webkit
```

Install the browser binary for the Playwright version pinned by this repository's lockfile (Playwright 1.64.0):

```sh
npx playwright install chromium
npx playwright install firefox
npx playwright install webkit
# Linux CI/all-engine hosts:
npx playwright install --with-deps chromium firefox webkit
```

`umb doctor` checks that the configured engine can launch headlessly; it does not install browsers or fall back to another engine. Locally installed binaries must match the locked Playwright version. Generated workflow specs select an engine with `UMB_PLAYWRIGHT_ENGINE=chromium|firefox|webkit` and default to Chromium; unknown values fail.

The adapter uses common Playwright browser/context/page/locator APIs. The engine smoke suite verifies launch, context/page lifecycle, navigation origin routing, locator interaction/assertions, accessibility snapshots, screenshots, and cleanup for each available browser. Engine-specific browser behavior can still differ; this is not a claim that every site, CSS feature, or API behaves identically across engines. CDP remains deferred and Chromium-only if added later. CI installs all three engines on Linux and sets `UMB_REQUIRE_ALL_ENGINES=1`; local focused runs skip only engines whose executable is absent.

Firefox/WebKit CI coverage currently runs on Linux with Node 24; the broader Windows/macOS and Node 20 matrix remains Chromium-only. Approval capture, file upload, diagnostics, popup/tab handling, and endpoint attachment are not individually cross-engine validated yet.

Firefox/WebKit CI coverage currently runs on Linux with Node 24; the broader Windows/macOS and Node 20 matrix remains Chromium-only. High-risk approvals, uploads, diagnostics, popup/tab handling, and endpoint attachment are not individually cross-engine validated yet.

## Benchmarking

Run `npm run --silent benchmark -- --quick` for local smoke measurements, or `npm run --silent benchmark` for the additional 10k-node/30k-edge graph fixture. Optional `--reps N` and `--warmups N` override sample and warm-up counts, for example `npm run --silent benchmark -- --quick --reps 1 --warmups 0`. `--silent` keeps npm's own banner out of stdout so the benchmark's single JSON document can be parsed directly. Fixtures and databases are temporary and use loopback-only local servers. It includes config/store/listener and browser timings, YAML reconciliation, compact snapshots, 100 sequential MCP browser clicks plus integrity checks, and (full mode) graph seed and separate SQLite-page-cache-cold/warm query samples. Cold here means `PRAGMA shrink_memory`; the OS filesystem cache may remain warm. Timing results include raw samples and summaries; this is measurement tooling, not a performance gate or claim. Results depend on Node/npm, OS, CPU/RAM, SQLite, locally installed Playwright Chromium, and machine load. Browser launch timing excludes browser download.

Limitations: The selected Playwright browser binary must be installed separately at the lockfile-matched Playwright version. SQLite uses `better-sqlite3` for synchronous, local transactions; installation may need a supported prebuilt binary or C++ build toolchain on unsupported Windows/Node combinations. Trace capture/artifact export remain unimplemented; optional CDP attachment is deferred. Stdio and authenticated local Playwright endpoint modes are supported. Native filesystem watcher notifications may be coalesced or dropped; UMB rescans/revalidates the full tree for each delivered change. Artifact references in evidence are retained after their files expire or are evicted. On Windows, Node's child-process signal API cannot prove graceful SIGINT delivery, so lifecycle cleanup is unit-tested through an injected controller while lock/restart behavior is process-tested. Upload source files must be inside the project root. Unauthenticated MCP categorically rejects requests carrying a browser `Origin`; use a non-browser MCP client without Origin or enable token auth. Checks: `npm run build`, `npm run typecheck`, `npm test`, and `npm run lint`.
# Artifact retention and high-risk approvals

Screenshot artifacts are managed PNGs in the reserved `.umb-managed/` subdirectory beneath `artifacts.directory`; arbitrary PNGs in the configured parent are not managed or deleted. Defaults are 10,000,000 bytes per file, 100,000,000 bytes total, 100 managed files, and 30 days; configure `artifacts.max_file_bytes`, `max_total_bytes`, `max_count`, and `max_age_days` within validated bounds. Expired/evicted artifacts may still be referenced by evidence rows; those references intentionally remain and point to expired artifacts. Failed screenshot capture does not discard assertion results. The managed directory and files use private POSIX modes (0700/0600); Windows ACL inheritance does not provide an equivalent POSIX guarantee. File operations validate canonical project containment and reject symlinks, but use path-based Node APIs rather than portable race-free directory handles; the remaining local-filesystem assumption is that an untrusted concurrent local process cannot replace directory entries between validation and use.

Explicit sensitive actions can be gated with `security.high_risk` rules, each containing `action`, an exact `target` (`{by: test_id, value: ...}` or `{by: role, role: ..., name: ...}`), and a trusted `description` (optionally exact `origin`). Exact action values protect only that action; use `action: any` to protect all target-addressed mutations (click/fill/press/select/type/keyboard/upload) on the configured element, including locator aliases. To protect a destructive control against click/keyboard/press aliases, use `any`. Rules are configuration authority, never derived from page content. Navigation/back/forward, tab lifecycle, and scroll tools are intentionally outside target approval; navigation remains constrained by the configured origin allowlist. Matching actions require exact current `expected_revision`, unique visible identity binding through execution, and interactive local TTY confirmation. CLI serve prompts with default-no behavior; non-TTY and library/server use without an injected approver deny. Approvals apply to one serialized request only.
