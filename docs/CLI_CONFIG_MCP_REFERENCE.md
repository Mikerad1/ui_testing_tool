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
| `umb memory backfill [--config <path>]` | Implemented, gated maintenance command that resumes redacted NLP processing of stored records. It can fail with a gate-disabled message; it is not an interactive memory doctor or a general learning-enable switch. |
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
| `memory.sensitive_paths`, `sensitive_values_env` | Defaults to empty lists. First accepts bounded JSON Pointer strings; second accepts environment-variable names, not secret values. Used for memory redaction configuration. |
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
| Workflow, sign-in, assertions | `test_run_workflow` runs a validated YAML workflow and requires current `expected_revision`; `application_sign_in` is only registered when configured; `test_assert` records an operational assertion/evidence record; `test_report` reads a report. |
| Persistent-memory reads/graph | `memory_context`, `memory_search`, `memory_get_node`, `memory_recall`, `memory_neighbors`, `memory_path`, `memory_stats`, `memory_conflicts`, `memory_export`. |
| Persistent-learning mutation interfaces | `memory_propose`, `memory_verify`, `memory_add_edge`, `memory_supersede`. Persistent-learning mutation is disabled in the current product state; do not invoke these as a learning workflow or claim persistent learning was saved. |
| Operational evidence | `memory_record_outcome` records project-scoped run/evidence data; operational assertion/run/evidence writes are distinct from persistent learning. |
| Narrow Jira publisher | `jira_publish_screenshot_table` is a bounded experimental screenshot-table publisher, not a Jira reader or general client. No Jira write is authorized here. |

Resources: `umb://project/current`, `umb://browser/current`, and ID-addressed `umb://memory/screen/{id}` / `umb://memory/workflow/{id}`. Resources expose only current project/browser status or the requested screen/workflow record.

Each tool response includes a project/session envelope and browser `state_revision`. Browser operations use one shared browser page/state across clients and are globally serialized, not isolated per client. A client's state can change between calls; pass the current `expected_revision` for supported mutations/workflow execution to reject stale state. Some high-risk configured target actions also require an exact revision and interactive local TTY approval. Navigation is limited by the configured origin policy. The separate `umb playwright endpoint` BrowserServer is not the browser used by `serve` or stdio and holds the project lock.

## Memory and spaCy status

There is no implemented `umb memory doctor` command. `umb memory backfill` is implemented but gated maintenance, not a status or provisioning command. The production persistent-learning mutation path is disabled; operational test/assertion/evidence writes remain available. The official release packages Python/spaCy/model components, but there is no documented source-checkout provisioning flow for that packaged spaCy sidecar/model. Do not invent pip/download commands or infer that `umb doctor` checks spaCy readiness: its checks do not include NLP health.

## Agent skills and host caveat

The implemented skill runtimes are `codex` and `copilot`. Codex uses `<project>/.agents/skills/umb-ui-testing/SKILL.md` and `~/.agents/skills/umb-ui-testing/SKILL.md`. Copilot CLI and VS Code Copilot share `<project>/.github/skills/umb-ui-testing/SKILL.md` and `~/.copilot/skills/umb-ui-testing/SKILL.md`. The installer changes skill files only; MCP server registration/configuration for UMB and any separately configured Jira MCP belongs to the user. Static path/frontmatter checks are not host-recognition tests. Current local caveat: Copilot CLI was absent; VS Code 1.133.0 was installed without the Copilot extension; the minimum Copilot CLI version is undocumented. Do not claim Copilot host recognition.

## Further references and known gaps

- [README quick start and project overview](../README.md)
- [Config parser/schema](../src/config/config.ts)
- [CLI command implementation](../src/cli/index.ts) and [generated agent command registration](../src/agent/cli.ts)
- [MCP server tools/resources/transports](../src/mcp/server.ts)
- [Knowledge schemas/reconciliation](../src/knowledge/reconcile.ts) and [workflow schema](../src/workflow/contract.ts)
- [Example project config and knowledge](../examples/demo-project/)

No separate source-checkout spaCy provisioning instructions, `memory doctor`, or tested generic MCP-client config is implemented/documented. The example project has application and screen YAML but no workflow seed example. No Jira access, Jira calls, or Jira writes are part of this reference.
