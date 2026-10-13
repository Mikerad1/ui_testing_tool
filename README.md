# UI Memory Browser

A local TypeScript CLI that serves browser automation and durable knowledge tools over authenticated MCP Streamable HTTP. For most users, download a prebuilt Windows or Linux bundle from [GitHub Releases](https://github.com/Mikerad1/ui_testing_tool/releases/latest); it includes a private Node.js runtime and production dependencies. The bundle is prebuilt, but is not a single-file executable: Windows uses `umb.cmd`, while Linux uses `umb`. Playwright browser binaries are installed separately. Building from source requires Node.js 20+ and a source checkout.

## Quick start with a prebuilt bundle

Download `umb-windows-x64.zip` or `umb-linux-x64.tar.gz` from [the latest release](https://github.com/Mikerad1/ui_testing_tool/releases/latest) and extract it. Open a terminal in the extracted bundle directory. These steps do not need `npm install`, `npm run build`, `npm link`, or `tsconfig.json`; the app and its Node runtime are already included.

First, create a project config and knowledge directory. Then copy and adapt the starter knowledge documents from [Copyable knowledge starter set](#copyable-knowledge-starter-set) into the created `umb-knowledge/` directory.

**Windows PowerShell**

```powershell
.\umb.cmd init --project demo --url http://127.0.0.1:3000
.\runtime\node.exe .\node_modules\playwright\cli.js install chromium
$env:UMB_MCP_TOKEN = '<set-a-long-random-secret>'
.\umb.cmd knowledge validate --config .\umb.config.yaml
.\umb.cmd doctor --config .\umb.config.yaml
.\umb.cmd serve --config .\umb.config.yaml
```

**Linux x64 shell**

```sh
./umb init --project demo --url http://127.0.0.1:3000
./runtime/bin/node ./node_modules/playwright/cli.js install chromium
export UMB_MCP_TOKEN='<set-a-long-random-secret>'
./umb knowledge validate --config ./umb.config.yaml
./umb doctor --config ./umb.config.yaml
./umb serve --config ./umb.config.yaml
```

`umb init` prompts for confirmation only when run in an interactive TTY (use `--yes` to skip); non-interactive runs proceed without a prompt. By default it creates an empty `umb-knowledge/` directory. Opt in to two editable sample documents with `--starter-knowledge`: `application.yaml` (application `start_screen: screen:home`) and `home.yaml` (an empty Home screen). These examples use the selected project ID and URL, are not written unless explicitly requested, and can be adapted to your application. To use a browser, install Chromium as shown. Linux may also need Playwright system libraries; see [Release bundles](#release-bundles). For a local source checkout and contributor commands, see [Build from source](#build-from-source).

## Build from source

These commands are for the repository checkout, which contains `tsconfig.json` and TypeScript source. Do not run `npm run build` inside a prebuilt release bundle; it intentionally contains the compiled app, not the TypeScript build configuration.

```sh
npm ci
npx playwright install chromium
npm run build
npm link
umb init --project demo --url http://127.0.0.1:3000
```

Set `UMB_MCP_TOKEN` to a long random secret before `umb serve`; use `$env:UMB_MCP_TOKEN = '<secret>'` in PowerShell or `export UMB_MCP_TOKEN='<secret>'` on POSIX. Then run `umb doctor` and `umb serve`.

Connect an MCP client to `http://127.0.0.1:7317/mcp` with `Authorization: Bearer <token>`. For a local subprocess MCP transport instead, run `umb mcp --stdio --config ./umb.config.yaml`; the parent MCP client launches UMB and communicates over stdin/stdout (stdout carries protocol messages only). `umb init` refuses to overwrite existing configuration. Set `server.auth.mode: none` only for explicitly trusted loopback development; it emits a warning. Target page origins are restricted to the configured base URL and `browser.allowed_origins`; each redirect hop is checked before it loads. Upload paths and screenshot artifacts are confined to the project root; screenshots mask form fields by default. Knowledge is validated as a complete tree before transactional upsert; YAML-owned removals become tombstones and agent knowledge is preserved.

## First-time setup and CLI reference

UMB uses two different kinds of YAML, and they are not interchangeable:

- **Configuration YAML** (normally `umb.config.yaml`) tells UMB how to run: project ID/base URL, server/auth settings, browser engine/origin allowlist, database, artifacts, and the knowledge directory. It is parsed against a strict config schema. `umb init` creates this file and a knowledge directory; it does not create the knowledge documents below.
- **Knowledge YAML** is a recursive tree of one strict document per `.yaml`/`.yml` file beneath `knowledge.path` (default `./umb-knowledge`). Each file must be one supported application, role, screen, workflow, or `navigation_rules` document. Documents reference other documents by IDs; workflow `{screen, element}` targets reference element IDs local to a screen. Unknown keys, malformed documents, duplicate IDs, or unresolved references reject the complete validation/reconcile operation.

The repository's `examples/demo-project/` directory contains a sample config and knowledge tree. A typical setup is:

```sh
umb init --project demo --url http://127.0.0.1:3000
# In a non-interactive terminal, init proceeds without a prompt; pass --yes to make that explicit.
# Review/edit umb.config.yaml, then place knowledge documents under umb-knowledge/.
umb knowledge validate --config ./umb.config.yaml
umb doctor --config ./umb.config.yaml
# Machine-readable diagnostics (JSON is written alone to stdout):
umb knowledge validate --json
umb doctor --json
```

Implemented CLI commands:

| Command | What it does |
| --- | --- |
| `umb init [--project <id>] [--url <url>] [--yes] [--starter-knowledge]` | Guided creation of `umb.config.yaml` and `umb-knowledge/`; safely serializes YAML, validates URL protocol and project ID, and refuses existing targets without leaving partial output. Defaults: project `demo-web`, URL `http://127.0.0.1:3000`. `--starter-knowledge` creates exactly `application.yaml` and `home.yaml` (described above). |
| `umb doctor [--config <path>] [--json]` | Read-only checks for config/path safety, full knowledge schema/references, auth settings, an existing DB's integrity/schema, MCP port availability, and whether the configured browser engine launches headlessly. Reports next steps; does not migrate/create a DB or navigate to the application. JSON mode emits `{ok, checks}`; each check has stable `id`, `status`, `message`, and `remediation` fields (`name` is included for compatibility). Unexpected failures also produce one JSON failure result; error details go to stderr. |
| `umb serve [--config <path>] [--watch-knowledge] [--no-update-check]` | Starts Streamable HTTP MCP, reconciles knowledge, launches the configured browser, and holds project/database locks for the process lifetime. `--watch-knowledge` opts into debounced full-tree reconciliation. Token auth defaults to environment variable `UMB_MCP_TOKEN`. Official prebuilt bundles also perform a short, non-blocking release metadata check; use `--no-update-check` or `UMB_NO_UPDATE_CHECK=1` to disable it. |
| `umb --update` (or `umb update`) | Downloads the latest stable GitHub release for an official prebuilt bundle, verifies the archive against its SHA-256 sidecar, and replaces only UMB's runtime, app, dependencies, launcher, and package metadata. Source checkouts and npm installs refuse; project files such as `umb.config.yaml`, `umb-knowledge/`, and `.umb/` are never replaced. |
| `umb mcp --stdio --config <path>` | Starts the MCP service over local subprocess stdin/stdout; `--stdio` is required and there is no HTTP listener. Stdout contains protocol only. Holds the same project/database locks as `serve`. |
| `umb playwright endpoint [--config <path>] [--token-env <name>]` | Launches a separate Playwright BrowserServer behind a loopback, Bearer-authenticated, single-client proxy. Token variable defaults to `UMB_PLAYWRIGHT_ENDPOINT_TOKEN` and must contain at least 32 bytes. It is not the browser page used by `serve`/stdio and holds the project lock, so those modes cannot co-run for this project. |
| `umb knowledge validate [--config <path>] [--json]` | Read-only validation of the complete knowledge tree; does not open/migrate Store or mutate graph state. JSON mode emits `{ok, count, diagnostics}`; diagnostics use the same stable `id`, `status`, `message`, and `remediation` contract as doctor checks. Success includes an `ok` diagnostic; failure has `count: null` and a `fail` diagnostic. |
| `umb knowledge reload [--config <path>]` | Takes the project/database lock, opens Store, and reconciles the entire knowledge tree into the graph. This mutates graph/ownership state; stop `serve`, stdio, or endpoint first. Removing a previously imported YAML document can tombstone its YAML-owned graph nodes/edges. |
| `umb knowledge proposals [--config <path>]` | Lists workflow locator proposals while holding the project/database lock. Stop other UMB processes for that project first. |
| `umb knowledge confirm-locator <proposalId> [--config <path>]` | Requires an interactive local TTY and project lock. Confirms a reviewed manual YAML locator edit; it does not edit YAML for you. Stop other UMB processes first. |
| `umb workflow verify <workflowId> --run-id <runId> [--config <path>]` | Requires an interactive local TTY, current YAML, and a successful matching workflow run. Under lock, asks for explicit confirmation and records current-snapshot export eligibility. |
| `umb workflow export <workflowId> --output <relativePath> [--config <path>]` | Under lock, revalidates current knowledge and writes a new project-relative `.spec.ts` only if current-snapshot verification exists. Its parent directory must already exist; it refuses overwrite and never executes the generated file. |

Options shown are the implemented options; `--config` defaults to `umb.config.yaml`. Lock-taking commands fail while another UMB process owns the same project/database. `validate` and `doctor` are read-only; `reload` mutates graph reconciliation. The confirmation commands fail closed without an interactive local TTY. Use `umb --help` or `<command> --help` for generated usage; PRD-only/unsupported commands are not available.

`npm run build` compiles to `dist/`; `npm run typecheck` checks types without output; `npm test` runs Node tests through `tsx`; `npm run lint` runs ESLint on `src` and `tests`; `npm run benchmark` runs the benchmark (see Benchmarking). `npm run` lists scripts.

## Copyable knowledge starter set

Create each block as its own file beneath `knowledge.path` (default `./umb-knowledge/`). Keep the config file at the project root; config YAML is not knowledge YAML. Every file below is one document. Knowledge schemas are strict, so an unsupported or misspelled field rejects validation of the whole tree.

`umb-knowledge/application.yaml`

```yaml
schema_version: 1
kind: application
id: demo-app
name: Demo application
base_url: http://127.0.0.1:3000
start_screen: sign-in
route_patterns:
  - screen: sign-in
    path: /login
  - screen: dashboard
    path: /dashboard
```

`umb-knowledge/role.yaml`

```yaml
schema_version: 1
kind: role
id: member
name: Member
permissions:
  - sign-in
  - view-dashboard
```

`umb-knowledge/sign-in.yaml`

```yaml
schema_version: 1
kind: screen
id: sign-in
name: Sign in
elements:
  - id: username
    description: Username field
    locator:
      by: label
      value: Username
  - id: password
    description: Password field
    locator:
      by: label
      value: Password
    sensitive: true
  - id: submit
    description: Submit sign-in form
    locator:
      by: role
      role: button
      name: Sign in
actions:
  - id: submit-sign-in
    element: submit
    effect:
      navigates_to: dashboard
```

`umb-knowledge/dashboard.yaml`

```yaml
schema_version: 1
kind: screen
id: dashboard
name: Dashboard
elements:
  - id: welcome
    description: Welcome message
    locator:
      by: test_id
      value: welcome-message
```

`umb-knowledge/member-sign-in.yaml`

```yaml
schema_version: 1
kind: workflow
id: member-sign-in
name: Sign in as a member
requires:
  role: member
  environment:
    - local
variables:
  USERNAME:
    from_env: DEMO_USERNAME
    sensitive: true
  PASSWORD:
    from_env: DEMO_PASSWORD
    sensitive: true
steps:
  - id: open-login
    action: navigate
    path: /login
  - id: enter-username
    action: fill
    target:
      screen: sign-in
      element: username
    value: '${{ variables.USERNAME }}'
  - id: enter-password
    action: fill
    target:
      screen: sign-in
      element: password
    value: '${{ variables.PASSWORD }}'
  - id: submit
    action: click
    target:
      screen: sign-in
      element: submit
  - id: wait-for-dashboard
    action: wait
    condition: visible
    target:
      screen: dashboard
      element: welcome
    timeout_ms: 10000
  - id: check-dashboard
    action: assert
    condition: text
    target:
      screen: dashboard
      element: welcome
    expected: Welcome
    match: contains
end_screen: dashboard
```

The IDs/references are intentionally consistent: application routes and workflow targets use screen IDs; screen actions point to an element in that same screen; the workflow's role and elements reference the other YAML documents. Workflow navigation paths are safe app-relative paths beginning with `/`. Exported/replayed environment values should be declared as whole-field `variables` references, not written as secrets in YAML. Check the whole tree with `umb knowledge validate --config ./umb.config.yaml` before serving. Reload always reconciles the whole tree: removing a previously owned YAML file can tombstone its YAML-owned graph entities, so keep every document you still intend to own under `knowledge.path`.

MCP provides browser status, navigation, popup-aware tab management, interactive/compact/full snapshots, semantic locators, click/fill/type/press/keyboard/select/scroll/wait, file upload, screenshot, back/forward, and project/browser/screen/workflow resources. The read-only `browser_errors` tool returns bounded diagnostic metadata when enabled. Tool responses include structured success/error envelopes. Memory context/search/get/propose/verify/export, graph edges/neighbors/path/conflicts/stats, deterministic `test_assert`, and `test_report` are available. Assertion outcomes and evidence are project-scoped in SQLite; failure screenshots mask form fields and report metadata omits input values. No raw SQL or page JavaScript interface is exposed. Never place credentials in knowledge YAML.

Browser diagnostics are disabled by default. To opt in, set one or more of `browser.diagnostics.console_errors`, `page_errors`, `failed_requests`, or `http_errors` to `true`; `browser.diagnostics.capacity` bounds the in-memory event buffer (1–1000, default 100). Events expose only safe metadata and an allowlisted origin; raw messages, URL paths/queries, headers, bodies, cookies, and form values are not captured or persisted. `browser_errors` supports cursor-based reads of the current process buffer.

`umb serve` and `umb mcp --stdio` hold an exclusive project lock under `.umb/locks` and a database lock adjacent to the canonical DB path before opening or mutating state; this also serializes overlapping project roots that resolve to the same DB. Stale same-host dead-PID locks are reclaimed under a per-lock exclusive gate; orphaned/malformed/remote-owner recovery gates fail closed and may need manual cleanup after verifying no owner is active. `umb doctor` is read-only: it validates YAML/config, checks an existing DB without migration, checks auth/port settings, and launches an ephemeral Chromium page without navigating to the application. The process owns one shared browser page and grants one MCP session a single-writer lease at a time. A second initializer receives HTTP 409 until the active session closes or expires after five minutes without requests. Browser tool operations are serialized within that lease; callers can use `expected_revision` to reject stale mutations. The idle timeout is injectable through the server API for tests. Shutdown drains MCP work before closing resources.

## Application sign-in

Application sign-in is opt-in. The strict `application_auth` configuration supports either interactive sign-in or a configured workflow. UMB does not log in during startup: call the `application_sign_in` MCP tool when sign-in is needed. The tool takes no credentials or workflow ID from the caller; the selected mode and, for workflow mode, workflow ID come only from trusted configuration. Workflow mode requires the current `expected_revision`; interactive mode can be called without `expected_revision`.

For manual sign-in, set `mode: interactive` and `browser.headless: false`. UMB opens a visible browser and you complete the login, including any MFA prompts, yourself. For workflow sign-in, set `mode: workflow` and the ID of a dedicated YAML workflow. That workflow runs on demand through `application_sign_in`; declare any secret values as environment-backed workflow variables, not as tool inputs or YAML literals.

The browser origin allowlist must contain the exact origins used by the flow, including the Microsoft Entra sign-in origin and your application's callback origin. Do not use wildcard origins. For example, replace these origins and IDs with the exact values for your tenant and application:

```yaml
browser:
  headless: true
  allowed_origins:
    - https://login.microsoftonline.com
    - https://app.example.com
application_auth:
  mode: workflow
  workflow_id: entra-sign-in
```

The dedicated workflow is a knowledge YAML document. This example reads credentials from process environment variables; it does not put their values in the file:

```yaml
schema_version: 1
kind: workflow
id: entra-sign-in
name: Sign in to the application
variables:
  ENTRA_USERNAME:
    from_env: ENTRA_USERNAME
    sensitive: true
  ENTRA_PASSWORD:
    from_env: ENTRA_PASSWORD
    sensitive: true
steps:
  - id: enter-username
    action: fill
    target:
      screen: sign-in
      element: username
    value: '${{ variables.ENTRA_USERNAME }}'
  - id: enter-password
    action: fill
    target:
      screen: sign-in
      element: password
    value: '${{ variables.ENTRA_PASSWORD }}'
  - id: submit
    action: click
    target:
      screen: sign-in
      element: submit
end_screen: dashboard
```

Set those variables in the environment before starting UMB (for example, `export ENTRA_USERNAME=...` and `export ENTRA_PASSWORD=...` in a POSIX shell, or `$env:ENTRA_USERNAME = '...'` and `$env:ENTRA_PASSWORD = '...'` in PowerShell), then start `umb serve` or `umb mcp --stdio` as usual. Never put credentials in YAML or pass them through model-visible tool calls. `sensitive: true` helps UMB handle workflow values as sensitive, but it is not a complete redaction guarantee. Automatic workflow-failure captures are suppressed for the configured application-auth workflow. Explicit screenshots and `test_assert` failure captures remain available, but input, textarea, and select controls are masked whenever `application_auth` is configured, even if `artifacts.redact_sensitive: false`. Visible page text can still contain account data, so do not treat all browser content as secret-proof.

Sign-in is not persisted across UMB restarts, so authenticate again after restarting. UMB does not bypass MFA or Conditional Access: interactive sign-in leaves those steps to the user, and a workflow that encounters them must still be completed through the application's normal security process.

## Workflow replay and recall

For explicit Playwright client attachment, set `UMB_PLAYWRIGHT_ENDPOINT_TOKEN` to a random secret of at least 32 bytes and run `umb playwright endpoint --config ./umb.config.yaml`; copy the printed loopback WebSocket URL into the trusted client and supply `Authorization: Bearer <token>` (Playwright `chromium.connect` headers). The URL is not authentication; the bearer token is required. The endpoint owns its launched browser and holds the project lock until shutdown. Optional CDP attachment is deferred.

This endpoint starts a separate Playwright `BrowserServer` for the external Playwright client. It is not the `BrowserController` page or context used by `umb serve` or `umb mcp --stdio`; the project lock prevents those UMB modes from running concurrently for the same project, and the endpoint proxy permits only one external WebSocket client at a time.

`test_run_workflow` executes only YAML-authored, strictly validated workflows. Call it with `workflow_id`, optional role/environment context, and the current `expected_revision`. Role/environment are applicability context, not authorization credentials. Environment values resolve only from declared whole-field `${{ variables.NAME }}` references, remain in memory, and are omitted from run reports. Preconditions run before browser mutations; retries are limited to bounded wait steps. Matching configured high-risk target actions still prompt for a separate local TTY approval on each action.

`memory_recall` is read-only: it derives the current route from the active browser and returns up to three YAML-authored workflow recommendations with safe action summaries, directed route paths, evidence/run citations, and explicit uncertainty. It omits payload values, expected text, raw locator payloads, page content, and URL query data. Recall never executes a workflow or bypasses its preconditions/approvals.

## Reviewed workflow spec export (P2A)

After a workflow has a successful project-scoped `test_run_workflow` run, explicitly verify that run from a local interactive TTY, then export the current hash-bound YAML revision:

```sh
umb workflow verify <workflow-id> --run-id <run-id> --config ./umb.config.yaml
mkdir -p specs
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

HTTPS certificate verification is enabled by default. For trusted local development with a self-signed certificate, you may explicitly opt out:

```yaml
browser:
  ignore_https_errors: true # default: false
```

This is a Playwright browser-context-wide setting: it disables HTTPS certificate verification for **all HTTPS traffic from that browser context**, not just localhost. It does not bypass UMB's configured navigation-origin checks, but it can expose connections to untrusted or intercepted servers. Use it only in trusted local development and leave it unset (or `false`) otherwise.

The adapter uses common Playwright browser/context/page/locator APIs. The engine smoke suite verifies launch, context/page lifecycle, navigation origin routing, locator interaction/assertions, accessibility snapshots, screenshots, and cleanup for each available browser. Engine-specific browser behavior can still differ; this is not a claim that every site, CSS feature, or API behaves identically across engines. CDP remains deferred and Chromium-only if added later. CI installs all three engines on Linux and sets `UMB_REQUIRE_ALL_ENGINES=1`; local focused runs skip only engines whose executable is absent.

## Release bundles

Tagged releases publish `umb-windows-x64.zip` and `umb-linux-x64.tar.gz` platform bundles. These are directories containing the private Node 24 runtime used to build them, compiled `dist`, production `node_modules` (including the target-built native `better-sqlite3` addon), package metadata/lockfile, this README, the license, and a launcher. They are platform archives, not single-file binaries. Extract the archive and launch from its directory:

```powershell
.\umb.cmd serve --config .\umb.config.yaml
.\runtime\node.exe .\node_modules\playwright\cli.js install chromium
```

```sh
./umb serve --config ./umb.config.yaml
./runtime/bin/node ./node_modules/playwright/cli.js install chromium
```

The Playwright browser binaries are intentionally not included. Install them with the bundle's Node runtime and bundled Playwright CLI; choose `firefox` or `webkit` instead of `chromium` when configured. On Linux, browser installation may require system libraries; use `--with-deps` on a supported Debian/Ubuntu system with package-install privileges (or install the documented Playwright OS dependencies separately). Binary versions must match the Playwright package in the bundle lockfile.

Pushing a tag exactly matching the package version, for example `v1.2.3`, from a commit reachable from `main` runs native Windows x64 and Ubuntu 22.04 x64 build/test/package jobs and publishes both archives with SHA-256 checksums and generated release notes. Release publishing is tag-triggered; it does not change repository visibility or branch protection.

Official bundles support `umb update`; the first metadata check on `umb serve` is best-effort and never delays startup, and notices are written only to stderr. Set `UMB_NO_UPDATE_CHECK=1` or pass `--no-update-check` to opt out. Checks run only for official prebuilt bundles, not source checkouts/npm installs; `umb update` refuses those installs. Updates use the fixed GitHub repository above, require a stable newer version and a matching SHA-256 sidecar, and fail without changing files on malformed metadata, checksum, or archive layout. The updater preserves arbitrary files in the bundle directory, including project configuration and data. Windows stages the verified payload and waits for the current UMB process to exit before replacing bundle files. Keep a backup of valuable local data; a power loss during file replacement cannot be made fully transactional across all filesystems. You can always update manually by extracting a newer release bundle and copying only its application payload files.

## Benchmarking

Run `npm run --silent benchmark -- --quick` for local smoke measurements, or `npm run --silent benchmark` for the additional 10k-node/30k-edge graph fixture. Optional `--reps N` and `--warmups N` override sample and warm-up counts, for example `npm run --silent benchmark -- --quick --reps 1 --warmups 0`. `--silent` keeps npm's own banner out of stdout so the benchmark's single JSON document can be parsed directly. Fixtures and databases are temporary and use loopback-only local servers. It includes config/store/listener and browser timings, YAML reconciliation, compact snapshots, 100 sequential MCP browser clicks plus integrity checks, and (full mode) graph seed and separate SQLite-page-cache-cold/warm query samples. Cold here means `PRAGMA shrink_memory`; the OS filesystem cache may remain warm. Timing results include raw samples and summaries; this is measurement tooling, not a performance gate or claim. Results depend on Node/npm, OS, CPU/RAM, SQLite, locally installed Playwright Chromium, and machine load. Browser launch timing excludes browser download.

Limitations: The selected Playwright browser binary must be installed separately at the lockfile-matched Playwright version. SQLite uses `better-sqlite3` for synchronous, local transactions; installation may need a supported prebuilt binary or C++ build toolchain on unsupported Windows/Node combinations. Trace capture/artifact export remain unimplemented; optional CDP attachment is deferred. Stdio and authenticated local Playwright endpoint modes are supported. Native filesystem watcher notifications may be coalesced or dropped; UMB rescans/revalidates the full tree for each delivered change. Artifact references in evidence are retained after their files expire or are evicted. On Windows, Node's child-process signal API cannot prove graceful SIGINT delivery, so lifecycle cleanup is unit-tested through an injected controller while lock/restart behavior is process-tested. Upload source files must be inside the project root. Unauthenticated MCP categorically rejects requests carrying a browser `Origin`; use a non-browser MCP client without Origin or enable token auth. Checks: `npm run build`, `npm run typecheck`, `npm test`, and `npm run lint`.
# Artifact retention and high-risk approvals

Screenshot artifacts are managed PNGs in the reserved `.umb-managed/` subdirectory beneath `artifacts.directory`; arbitrary PNGs in the configured parent are not managed or deleted. Defaults are 10,000,000 bytes per file, 100,000,000 bytes total, 100 managed files, and 30 days; configure `artifacts.max_file_bytes`, `max_total_bytes`, `max_count`, and `max_age_days` within validated bounds. Expired/evicted artifacts may still be referenced by evidence rows; those references intentionally remain and point to expired artifacts. Failed screenshot capture does not discard assertion results. The managed directory and files use private POSIX modes (0700/0600); Windows ACL inheritance does not provide an equivalent POSIX guarantee. File operations validate canonical project containment and reject symlinks, but use path-based Node APIs rather than portable race-free directory handles; the remaining local-filesystem assumption is that an untrusted concurrent local process cannot replace directory entries between validation and use.

Explicit sensitive actions can be gated with `security.high_risk` rules, each containing `action`, an exact `target` (`{by: test_id, value: ...}` or `{by: role, role: ..., name: ...}`), and a trusted `description` (optionally exact `origin`). Exact action values protect only that action; use `action: any` to protect all target-addressed mutations (click/fill/press/select/type/keyboard/upload) on the configured element, including locator aliases. To protect a destructive control against click/keyboard/press aliases, use `any`. Rules are configuration authority, never derived from page content. Navigation/back/forward, tab lifecycle, and scroll tools are intentionally outside target approval; navigation remains constrained by the configured origin allowlist. Matching actions require exact current `expected_revision`, unique visible identity binding through execution, and interactive local TTY confirmation. CLI serve prompts with default-no behavior; non-TTY and library/server use without an injected approver deny. Approvals apply to one serialized request only.

## License

This project is licensed under the MIT License. See [LICENSE](./LICENSE).
