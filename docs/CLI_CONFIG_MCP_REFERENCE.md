# CLI, configuration, MCP, and knowledge reference

This guide documents implemented UMB behavior, not planned features. Check the installed version's generated help (`umb --help`, `umb <command> --help`) for the authoritative option list. It does not authorize Jira writes or change the README's separate Jira-use restrictions.

## Install context and command basics

UMB is launched with the `umb` root launcher from a source installation (`npm link`) or an extracted prebuilt bundle. Keep each app project's config, knowledge, and `.umb/` data in a dedicated project directory, outside the release bundle. All config-relative data paths are resolved from the directory containing the selected config file and must remain within that project root; escaping symlinks are rejected.

The global `--update` option and `umb update` update official prebuilt bundles; they are not source-checkout update commands. `--config <path>` options default to `umb.config.yaml`. `umb init` defaults to project ID `demo-web` and URL `http://127.0.0.1:3000`; it creates a config and empty `umb-knowledge/`, refusing to overwrite either. `--starter-knowledge` additionally creates `application.yaml` and `home.yaml`. In a terminal, init asks before creating; `--yes` skips the prompt. A non-interactive run proceeds without a prompt.

### Command groups and effects

| Command | Behavior and effects |
| --- | --- |
| `umb doctor [--config <path>] [--json]` | Read-only checks config and path safety, YAML, auth/token, existing DB integrity/schema, port availability, and headless browser launch. Does not create/migrate a DB or navigate to the app. |
| `umb knowledge validate [--config <path>] [--json]` | Read-only full-tree YAML schema/reference check; does not open the graph store. |
| `umb serve [--config <path>] [--watch-knowledge] [--no-update-check]` | Starts configured HTTP MCP (token auth is the default), opens/reconciles project state and browser, and holds project/database locks. Optional watch performs debounced full-tree reconciliation. Official bundles may do a best-effort release check; disable with `--no-update-check` or `UMB_NO_UPDATE_CHECK=1`. |
| `umb mcp --stdio [--config <path>]` | Starts MCP over a local subprocess's stdin/stdout; `--stdio` is required and there is no HTTP listener. Stdout carries protocol only. |
| `umb knowledge reload [--config <path>]` | Lock-taking full-tree reconciliation. It mutates graph/ownership state; removal of a previously imported YAML source can tombstone YAML-owned records. Stop other UMB processes for this project first. |
| `umb knowledge proposals [--config <path>]` | Lock-taking list of workflow locator proposals. |
| `umb knowledge confirm-locator <proposalId> [--config <path>]` | Local interactive TTY confirmation of an already reviewed manual YAML locator edit; does not edit YAML itself. Lock-taking. |
| `umb workflow verify <workflowId> --run-id <runId> [--config <path>]` | Interactive local TTY confirmation of export eligibility for a successful matching run/current YAML revision. Lock-taking. |
| `umb workflow export <workflowId> --output <relativePath> [--config <path>]` | Writes a new project-relative `.spec.ts` only after verification. Parent directory must exist; refuses overwrite; does not execute generated code. Lock-taking. |
| `umb playwright endpoint [--config <path>] [--token-env <name>]` | Starts a separate loopback-authenticated Playwright BrowserServer for one external client. Token env defaults to `UMB_PLAYWRIGHT_ENDPOINT_TOKEN` and must contain at least 32 bytes. Holds the project lock; do not run concurrently with `serve`/stdio for that project. |
| `umb agent list` | Read-only skill installation status for Codex and Copilot. |
| `umb agent install --runtime codex\|copilot --scope project\|user [--dry-run] [--force]` | Installs the portable skill. Dry-run previews; force backs up before replacing a different existing skill. Does not edit MCP configuration. |
| `umb agent uninstall --runtime codex\|copilot --scope project\|user [--dry-run]` | Removes only unchanged managed skill content. |
| `umb agent doctor --runtime codex\|copilot [--scope project\|user] [--json]` | Read-only runtime/skill diagnostics. It does not establish host recognition. |
| `umb memory doctor [--config <path>] [--json]` | Read-only config, NLP runtime/sidecar health, configured-project versus packaged pattern-loading diagnostics, and existing SQLite integrity/schema checks. Does not create or migrate a database, provision Python/spaCy, or enable persistent-learning writes. Invalid configured patterns do not fall back to packaged defaults. |
| `umb memory backfill [--config <path>]` | Implemented, gated maintenance command that resumes redacted NLP processing of stored records. Reports per-invocation `scanned`, `migrated`, `merged`, `rejected`, `stale`, `failed`, and `unchanged` counts separately from durable job totals; batches are limited to 50 records, with no total-record or time cap. It can fail with a gate-disabled message; it is not a general learning-enable switch. |
| `umb memory reindex --dry-run [--config <path>] [--limit <number>]` | Bounded read-only reprocessing preview (default 100, maximum 1000). `--dry-run` is required. Requires an existing current-schema database and readable WAL sidecars when the database is in WAL mode; it fails closed if sidecars are unavailable or the journal mode differs from the preflight. No filesystem-mutation guarantee applies if another process changes journal mode concurrently. Do not run during database or journal-mode maintenance. It creates no job or persistent state, and does not establish packaged/runtime NLP evidence. |
| `umb jira comment <issue_key> --site <origin> --image <path> [--config <path>] [--write] [--experimental-inline-wiki] [--table] [--email-env <name>] [--token-env <name>]` | Narrow experimental screenshot-comment publisher. Local-only dry-run is default; both write opt-ins are required for network writes. This reference does not authorize use. There is no general UMB Jira client or issue discovery. |

**`--force` recovery warning:** Use forced skill replacement only when the target's parent tree is trusted and no other same-user process can mutate it. Replacement is not atomic or crash-recoverable. Abrupt termination can leave the target absent with the original data in a `.umb-skill-quarantine-*` directory. After a crash, inspect the target and quarantine before restoring; on a command failure, follow its reported recovery path. Do not overwrite competing data.

Commands taking the project lock fail while another lock-taking UMB process owns the same project/database. `serve`, stdio and endpoint modes keep that lock for their lifetime. Read-only validation and doctor are safe to run without changing graph state.

## Configuration schema

`umb.config.yaml` has `version: 1`. `umb init` writes the common fields below; omitted optional fields receive the schema defaults. Config objects are strict: unknown keys, wrong types, invalid values, duplicate YAML keys, or missing required fields reject the config. See [`src/config/config.ts`](../src/config/config.ts), [`src/cli/index.ts`](../src/cli/index.ts), and the working [demo config](../examples/demo-project/umb.config.yaml).

| Section / key | Meaning and defaults |
| --- | --- |
| `project.id`, `project.name`, `project.base_url` | Required. ID contains letters, digits, `_`, `-`; name is non-empty; URL must parse as a URL. `init` uses its selected ID as name. |
| `server.host`, `server.port` | Default `127.0.0.1`, `7317`. HTTP serving permits only loopback hosts. Port is an integer 1–65535. |
| `server.auth.mode`, `server.auth.token_env` | Default `token`, `UMB_MCP_TOKEN`. Set the named environment variable before `serve`. `none` is unauthenticated local development only and emits a warning; it must bind loopback. HTTP token auth is not used by stdio transport. |
| `browser.engine`, `browser.headless` | Default `chromium`, `true`; engine is `chromium`, `firefox`, or `webkit`. Install the matching Playwright browser separately. |
| `browser.allowed_origins` | Default empty list in schema; `init` sets the exact origin from `project.base_url`. Navigation and redirect hops are checked against configured base URL/allowlist; use exact origins, not wildcards. |
| `browser.viewport` | Default `{width: 1440, height: 900}`; both dimensions must be positive integers. |
| `browser.ignore_https_errors` | Default `false`. If enabled, disables certificate checking for all HTTPS traffic in that browser context; use only for trusted development. |
| `browser.diagnostics` | All event switches default false: `console_errors`, `page_errors`, `failed_requests`, `http_errors`. `capacity` defaults to 100 (1–1000). Diagnostics are process-memory bounded metadata, not raw page/network payload capture. |
| `application_auth` | Optional strict object: `{mode: interactive}` or `{mode: workflow, workflow_id: <safe-id>}`. Interactive mode requires `browser.headless: false`. Startup does not sign in; use the configured MCP sign-in flow. |
| `artifacts.directory` | Defaults to `./.umb/artifacts`; `init` writes this value. Paths stay within the config project root. |
| `artifacts.redact_sensitive` | Default `true`; `init` writes true. Keep enabled for managed screenshots and publisher eligibility. |
| `artifacts.max_file_bytes`, `max_total_bytes`, `max_count`, `max_age_days` | Defaults respectively 10,000,000; 100,000,000; 100; 30. Schema bounds are 1 KiB–100 MB, 1 KiB–1 GB, 1–10,000 files, and 1–3650 days. |
| `memory.database` | Defaults to `./.umb/memory.sqlite`; `init` writes this value. SQLite is project-scoped. |
| `memory.environment` | Optional configured environment identity; must satisfy the environment validator. |
| `memory.python_executable` | Optional absolute path override for the sidecar Python executable. Its presence does not provision Python, spaCy, or a model. |
| `memory.patterns_file` | Optional project-relative JSON patterns file. Valid project rules are added to packaged rules; a valid empty file therefore leaves packaged rules active. Invalid configured rules fail closed rather than falling back. Packaged patterns are used alone when no project file is configured. |
| `memory.sensitive_paths`, `sensitive_values_env` | Defaults to empty lists. First accepts bounded JSON Pointer strings; second accepts environment-variable names, not secret values. Used for memory redaction configuration. |
| `memory.trust_yaml_seeds` | Defaults to `false`. When `true`, current conflict-free YAML-owned records may be included in trusted retrieval as `trusted_seed`; their verification status is unchanged. With the default, authored YAML appears separately as unverified guidance where supported. |
| `memory.persistent_learning_writes` | Defaults to `false` (omitted means false). Explicitly set `true` to opt this project into the normal persistent LearningWriter path for MCP proposal writes and YAML reconciliation, including applicable serve/startup/reload/watch flows. Writes pass through redaction and require healthy spaCy readiness. This is a per-project opt-in, not a global default. It does not enable bulk backfill, which remains separately disabled/operator-gated. |
| `knowledge.path` | Defaults to `./umb-knowledge`; `init` writes this value. Contains knowledge YAML only, not config YAML. |
| `security.high_risk` | Optional list (max 100) of strict approval rules. Each has an action (`click`, `fill`, `press`, `select`, `type`, `keyboard`, `upload`, or `any`), exact role/test-id target, trusted description, and optional exact origin. Matching actions require a current revision and local interactive approval; non-TTY use denies. |

`umb doctor` validates config and project paths, checks token availability and loopback binding, validates knowledge, checks an existing database read-only (it does not migrate it), probes the port, and tries to launch the selected browser headlessly. It does not navigate to the configured web app. A fresh database may be reported as not initialized until a write-capable UMB startup creates it.

## Knowledge YAML

Knowledge is a recursive tree of `.yaml`/`.yml` files below `knowledge.path`. Each file contains exactly one strict `schema_version: 1` document. Supported `kind` values and basic contents:

- `application`: required `id`, `name`; optional `base_url`, `start_screen`, `route_patterns`.
- `role`: required `id`, `name`; optional `permissions`.
- `screen`: required `id`, `name`; optional `route`, `landmarks`, `elements`, and `actions`. Elements can define locators (`role`, `label`, `placeholder`, `test_id`, `text`, `css`), fallbacks, and sensitivity. An action element ID must be local to that screen.
- `workflow`: required `id`, `name`, and one or more steps; optional screens, role/environment requirements, preconditions, environment-backed variables, and failure handling. Supported steps include app-relative navigation, locator actions, bounded waits, and assertions. Workflow IDs/step IDs and references are checked; credentials belong in environment variables, not YAML literals.
- `navigation_rules`: required `id`, `rules`; optional `name`. Rules connect existing screens and can state action, preconditions, and verification.

The actual schemas are in [`src/knowledge/reconcile.ts`](../src/knowledge/reconcile.ts) and [`src/workflow/contract.ts`](../src/workflow/contract.ts). Unknown fields are rejected. The complete tree is checked for duplicate kind/ID identities, malformed documents, unsupported kinds, unresolved/wrong-kind references, invalid screen element references, and unsafe symlink paths. `umb knowledge validate` checks schemas and references only; it does not open the graph store or change state.

At UMB startup, reconciliation validates the complete tree and references before committing a complete desired state. The YAML source tree is re-read/reconciled as a whole; removing a previously YAML-owned document can tombstone its owned graph nodes/edges, while independently owned agent knowledge is preserved. `umb knowledge reload` takes the project lock and mutates graph state. `--watch-knowledge` treats filesystem events as hints for debounced full-tree reconciliation. If NLP preprocessing is unavailable during startup, the last valid graph can remain active and learning ingestion is unavailable; an invalid tree does not replace valid graph data (startup fails rather than reconciling invalid input).

Examples: [demo config](../examples/demo-project/umb.config.yaml), [application seed](../examples/demo-project/umb-knowledge/app.yaml), and [screen seed](../examples/demo-project/umb-knowledge/home.yaml). The example project contains no workflow seed document; use the linked workflow schema source for the implemented contract rather than assuming a workflow example exists.

## MCP transports and behavior

### Streamable HTTP

`umb serve --config <path>` listens at `http://<server.host>:<server.port>/mcp` (defaults `http://127.0.0.1:7317/mcp`). In token mode, the server reads the configured `token_env` variable, default `UMB_MCP_TOKEN`; clients send `Authorization: Bearer <token>`. Missing token prevents startup. HTTP is loopback-only. With auth disabled, requests carrying a browser `Origin` are rejected; do not use unauthenticated mode outside trusted loopback development. HTTP MCP sessions expire after five minutes idle.

### Local stdio

`umb mcp --stdio --config <path>` starts the same service as a local MCP subprocess, without an HTTP listener. The client must launch the process and communicate over stdin/stdout. Stdout is protocol-only; status/errors are on stderr. The project lock and shared browser apply just as with HTTP.

### Tool and resource groups

Tools below are the implemented groups, not a promise that every operation is appropriate for every task. Generated tool schemas/descriptions are the exact argument contracts.

| Group | Implemented capabilities |
| --- | --- |
| Browser status/diagnostics | `browser_status`, `browser_refresh`, `browser_errors`. Refresh retries the configured base URL; errors are bounded safe diagnostics and are disabled unless configured. |
| Browser navigation and page | `browser_navigate`, `browser_snapshot`, `browser_find`, `browser_screenshot`, `browser_set_viewport`, `browser_back`, `browser_forward`, `browser_tabs`, `browser_tab_select`, `browser_tab_create`, `browser_tab_close`. |
| Browser interaction | `browser_click`, `browser_fill`, `browser_type`, `browser_press`, `browser_keyboard`, `browser_select`, `browser_scroll`, `browser_wait_for`, `browser_upload`. Upload sources must be project-relative. |
| Direct desktop interaction (experimental/PARTIAL) | Direct desktop tools accept legacy CSS strings plus `{by:'role', role, name?}`, `{by:'test_id', value}`, and `{by:'placeholder', value}`. `test_id` is exact `data-testid`; role/name matching is exact and case-sensitive using explicit role or a small tag fallback and a trimmed `aria-label`/`innerText`/`alt` name approximation (maximum 300 characters), not full ARIA semantics. Placeholder matching uses exact, case-sensitive equality on the raw `placeholder` attribute with no whitespace normalization; eligible elements are `textarea` and `input` types `text`, `search`, `url`, `tel`, `email`, or `password`. The placeholder target value is strictly 1–1000 characters. Semantic mutation actions require one visible, enabled match. This is a bounded DOM locator, not full Playwright parity. Label and text targets remain unsupported; Tauri YAML remains CSS-only. `desktop_upload` additionally accepts one project-relative regular file (<=20 MiB) beneath the configured desktop root for a unique enabled `input[type=file]` in an already-running managed session. It uses W3C Element Send Keys only, rejects traversal/symlink escapes/CRLF paths, and returns only basename and byte length. Any configured high-risk `upload` or `any` rule blocks all desktop uploads because no desktop approval prompt is available. Native upload and locator acceptance is verified only on Fedora 44 WebKitGTK/WebKitWebDriver 2.54.1-1.fc44. `browser_*` and `test_run_workflow` remain Playwright-backed. |
| Workflow, sign-in, assertions | `test_run_workflow` runs a validated YAML workflow and requires current `expected_revision`; `application_sign_in` is only registered when configured; `test_assert` records an operational assertion/evidence record; `test_report` reads a report. |
| Persistent-memory reads/graph | `memory_context`, `memory_search`, `memory_get_node`, `memory_recall`, `memory_neighbors`, `memory_path`, `memory_stats`, `memory_conflicts`, `memory_export`. `memory_candidates` filters immutable ledger state using `stored_status` and reports derived `current_status`. Its data payload is bounded to 20 KiB; pagination retains progress and indicates omitted fields/rows (MCP responses contain structured and text copies). Extracted candidates remain unverified. `memory_conflicts` is an explicitly unverified review and omits entity keys. |

`memory_search` accepts `query` (required), optional `mode` (`auto`, `exact`, or `prose`), `page_size` (1–50, default 50), and `cursor`. Query-only calls remain supported. Auto combines byte/case-sensitive exact indexed values with NFKC/lowercased all-token prose matches; exact and prose modes select only that branch. Search returns compact trusted-node projections in `data` and pagination metadata as a sibling field in the MCP success envelope. Continue with `pagination.next_cursor`; cursors bind the query and options and expire after index changes. Cursors are not durable across Store/process restart; because the old process-local key is unavailable for HMAC verification, a cursor from a restart reports `invalid_cursor`. Search pages are bounded to 16 KiB and complete MCP results to 48 KiB; an overlarge required projection or wire response fails closed with empty `data` and `pagination.status: too_broad`. Use `memory_get_node` for full node attributes.
| Persistent-learning proposal interfaces | `memory_propose`, `memory_add_edge`. Writes are disabled by default; set `memory.persistent_learning_writes: true` in a project config to opt that project into the normal LearningWriter path for MCP proposal writes and YAML reconciliation (including applicable serve/startup/reload/watch flows), through redaction and healthy spaCy readiness. `memory_propose` and `memory_add_edge` require 1–5 `evidence_refs`, each containing `evidence_id`, `run_id`, and `subject_node_id`, referring to a passed assertion from the same project and environment. The assertion subject must be live; for an edge it must be one of the endpoints. A PASS result from `test_assert` returns a copy-ready ref. These checks establish provenance, existence, and scope only—not semantic support for proposed claims—and neither verify candidates nor bind claims to evidence. `memory_candidates` exposes status and refs; legacy MCP rows remain unlinked. YAML and backfill preserve source/revision provenance and do not require assertion refs. `memory_verify` remains a separate local-human approval/direct-evidence path. Never persist secrets or raw sensitive values. Proposals remain unverified. This property does not enable bulk backfill, which remains separately disabled/operator-gated. |
| Persistent-learning verification/lifecycle | `memory_verify`, `memory_supersede`. `memory_verify` requires local human approval plus evidence-gated criteria; assertion evidence is not automatically bound to a particular claim. Verification is separate from proposal and is not part of the default agent proposal workflow. Bulk `umb memory backfill` remains separately disabled/operator-gated. |
| Operational evidence | `memory_record_outcome` records project-scoped run/evidence data; operational assertion/run/evidence writes are distinct from persistent learning. |
| Narrow Jira publisher | `jira_publish_screenshot_table` is a bounded experimental screenshot-table publisher, not a Jira reader or general client. No Jira write is authorized here. |

Resources: `umb://project/current`, `umb://browser/current`, and ID-addressed `umb://memory/screen/{id}` / `umb://memory/workflow/{id}`. Resources expose only current project/browser status or the requested screen/workflow record.

Each tool response includes a project/session envelope and browser `state_revision`. Browser operations use one shared browser page/state across clients and are globally serialized, not isolated per client. A client's state can change between calls; pass the current `expected_revision` for supported mutations/workflow execution to reject stale state. Some high-risk configured target actions also require an exact revision and interactive local TTY approval. Navigation is limited by the configured origin policy. The separate `umb playwright endpoint` BrowserServer is not the browser used by `serve` or stdio and holds the project lock.

## Memory and spaCy status

`umb memory doctor --config <path> [--json]` checks config/path safety, NLP runtime and sidecar health, configured-versus-packaged pattern loading, and integrity/schema state for an existing SQLite database. Database inspection uses a read-only SQLite connection; a missing database is only reported as a warning, and the command never creates or migrates it. A strict older migration prefix recommends backup before normal migrations; a gapped or inconsistent history explicitly advises against running migrations and recommends recovery review. The packaged `python/patterns-v1.json` now covers all seven ontology labels and all five relation types. This bounded coverage/test evidence does not establish overall FR-07 acceptance; Windows-native package and other overall FR-07 acceptance evidence remain open; the Linux release-archive smoke has passed. Valid configured project rules are additive to packaged rules, so an empty valid custom file leaves packaged defaults active; invalid configured patterns fail closed. Unhealthy NLP readiness is rejected. Healthy normalization-only/no-effective-pattern health may persist normalized-only observations without extracting candidates. The doctor does not provision Python/spaCy or download a model. Official releases include Python/spaCy/model components, but there is no documented source-checkout provisioning flow. Safe proposal writes use the existing spaCy/redaction boundary; they do not enable bulk backfill, which remains separately disabled/operator-gated. Operational test/assertion/evidence writes remain distinct. MCP proposal evidence refs are provenance/existence/scope checks only, not semantic support or verification. Candidates remain unverified, and `memory_verify` is a separate local-human approval/direct-evidence path. `umb doctor` does not check NLP health.

## Agent skills and host caveat

The implemented skill runtimes are `codex` and `copilot`. Codex uses `<project>/.agents/skills/umb-ui-testing/SKILL.md` and `~/.agents/skills/umb-ui-testing/SKILL.md`. Copilot CLI and VS Code Copilot share `<project>/.github/skills/umb-ui-testing/SKILL.md` and `~/.copilot/skills/umb-ui-testing/SKILL.md`. The installer changes skill files only; MCP server registration/configuration for UMB and any separately configured Jira MCP belongs to the user. Static path/frontmatter checks are not host-recognition tests. Current local caveat: Copilot CLI was absent; VS Code 1.133.0 was installed without the Copilot extension; the minimum Copilot CLI version is undocumented. Do not claim Copilot host recognition.

## Further references and known gaps

- [README quick start and project overview](../README.md)
- [Config parser/schema](../src/config/config.ts)
- [CLI command implementation](../src/cli/index.ts) and [generated agent command registration](../src/agent/cli.ts)
- [MCP server tools/resources/transports](../src/mcp/server.ts)
- [Knowledge schemas/reconciliation](../src/knowledge/reconcile.ts) and [workflow schema](../src/workflow/contract.ts)
- [Example project config and knowledge](../examples/demo-project/)

No separate source-checkout spaCy provisioning instructions or tested generic MCP-client config is implemented/documented. The example project has application and screen YAML but no workflow seed example. YAML seeds are unverified by default; `memory.trust_yaml_seeds: true` is an explicit retrieval opt-in and does not verify them. No Jira access, Jira calls, or Jira writes are part of this reference.
