# Enhancement PRD: Jira-Integrated Autonomous UI Testing Agent

**Version:** 1.2<br>
**Date:** 2026-10-17<br>
**Status:** Ready for engineering refinement — includes mandatory spaCy memory enhancement<br>
**Applies to:** Existing CLI-based headless browser testing tool with MCP navigation, SQLite graph memory, YAML ingestion, and ticket context.

## 1. Executive summary

Enhance the existing UI testing CLI so that an installable, runtime-compatible testing agent can autonomously validate Jira acceptance criteria (ACs) against a running application, reuse previously learned navigation knowledge, conduct positive and negative tests, persist new learnings, and publish a traceable Jira comment with screenshots and results. Upgrade the existing SQLite graph memory so **spaCy is a mandatory NLP processing stage for all new or updated persistent learnings**, including YAML-ingested knowledge and agent-authored memory writes.

The tool already has knowledge of the current ticket. **Do not rebuild ticket discovery, ticket selection, or ticket context management.** Extend the existing ticket context and add only the missing Jira read/write operations needed to obtain acceptance criteria and publish results with attached evidence.

## 2. Goals and non-goals

### Goals
1. First-party Jira integration for reliable screenshot attachment uploads and Jira comments, independent of the agent runtime's generic Jira MCP connector.
2. A CLI command that installs/configures a reusable UI testing agent for supported runtimes, starting with GitHub Copilot and OpenAI Codex.
3. Agent retrieves current ticket's ACs, creates coverage-oriented test cases, executes positive and negative scenarios, and records verifiable results.
4. Agent queries SQLite graph memory before testing and writes validated navigation/test learnings through existing memory MCP tools as it works.
5. Agent posts a single coherent Jira result comment with evidence references, with safe retries and no duplicate reports.
6. Reuse the existing lightweight headless browser, Playwright compatibility, YAML knowledge ingestion, and MCP server.
7. Require spaCy-based entity/relation extraction, normalization, and deduplication in the graph-memory write path; migrate existing learnings without data loss.

### Non-goals
- Replacing Jira ticket orchestration or creating tickets.
- Implementing a general-purpose Jira MCP server.
- Automatically changing ticket status, assigning tickets, or approving releases.
- Assuming all acceptance criteria are UI-testable; explicitly flag API-only, manual, ambiguous, or blocked requirements.
- Uploading secrets, unredacted credentials, or sensitive customer data in screenshots.

## 3. Personas and primary workflow

**Primary user:** Developer/QA engineer operating an agent runtime connected to the UI testing CLI.

**Happy path:**
1. User starts the CLI and connects the runtime through MCP.
2. User invokes the installed testing agent for the ticket already selected by the tool.
3. Agent reads ticket context and fetches fresh ACs through the first-party Jira integration.
4. Agent retrieves relevant graph memory, YAML seed knowledge, known routes, selectors, and prior test outcomes.
5. Agent produces a test plan mapping each AC to positive and negative test cases.
6. Agent navigates the application using browser MCP tools, captures screenshots, and records assertions.
7. Agent saves new, verified learnings through memory MCP tools; the underlying memory service processes writes with spaCy before persisting them to the SQLite graph.
8. Agent uploads selected screenshots as Jira attachments, then publishes a formatted comment with AC-by-AC results and evidence links.
9. Agent returns a structured final run summary and exit status to the caller.

## 4. Functional requirements

### FR-01: First-party Jira integration (P0)
- Add a Jira client module owned by the CLI, separate from the external Jira MCP integration.
- Support Jira Cloud first; abstract authentication and endpoints to allow Jira Data Center later.
- Configure base URL, auth mode, credentials reference, project allowlist, attachment limits, and report behavior.
- Support secure Jira Cloud authentication using an approved API token or OAuth mechanism; store secrets in environment variables/OS credential store, never in YAML, SQLite graph nodes, logs, or screenshots.
- Use the existing current-ticket identifier and existing ticket context; fetch ACs from configured Jira description sections and/or designated custom fields. Support Atlassian Document Format (ADF) parsing to normalized plain text while retaining source references.
- Respect Jira permissions and distinguish authentication, authorization, missing attachment permission, disabled attachments, network failures, and rate limits.
- Upload screenshots via Jira's attachment endpoint using multipart form data and the required Jira attachment header; create comments using the applicable Jira REST API and valid ADF body for Jira Cloud.
- Capture uploaded attachment IDs and URLs; include stable references in the comment. Do not assume inline rendering works identically across Jira deployments.
- Sanitize attachments and redact configured selectors/regions before upload; allow opt-out of upload while preserving local evidence.
- Retry transient errors with exponential backoff and bounded attempts; do not blindly retry non-idempotent operations without reconciliation.
- If uploads fail, publish a clearly marked evidence-incomplete report only if configured to do so; never claim an attachment exists when it does not.

**Acceptance criteria:** Given a valid Jira ticket and credentials with permissions, the tool retrieves ACs, uploads at least one screenshot, and creates a comment linking to that actual attachment. Missing permission produces a clear actionable error; no false success is reported.

### FR-02: Installable agent for multiple runtimes (P0)
- Provide CLI commands:
  - `uitest agent list`
  - `uitest agent install --runtime copilot [--scope project|user] [--force]`
  - `uitest agent install --runtime codex [--scope project|user] [--force]`
  - `uitest agent uninstall --runtime <runtime> [--scope project|user]`
  - `uitest agent doctor --runtime <runtime>`
- **Command names are proposed**; adapt to the actual CLI executable name without breaking existing commands.
- Maintain a canonical versioned agent specification with runtime-specific adapters that generate native agent instructions/configuration in the correct supported location and format for each runtime.
- Install or reference the existing MCP server configuration without overwriting unrelated user MCP settings. Handle JSON/TOML/Markdown or other runtime-native formats according to the adapter.
- Detect runtime presence/version where possible, back up files before modifying, use atomic writes, and make repeated installs idempotent.
- Installation should work offline for bundled templates and provide dry-run preview of file changes.
- Installed agent instructions must explain available browser, memory, and Jira tools, expected workflow, evidence standards, and reporting constraints.
- Document invocation instructions per runtime; do not assume a common slash command syntax.

**Acceptance criteria:** Installing for Copilot and Codex yields valid native agent definitions and MCP connection instructions, passes `agent doctor`, and does not damage pre-existing configuration. Reinstall is safe; uninstall removes only managed artifacts.

### FR-03: Ticket AC ingestion and test planning (P0)
- Resolve ticket from existing tool context; error if none selected rather than silently picking a different issue.
- Refresh ACs from Jira immediately before planning, with source field and retrieval timestamp.
- Parse numbered lists, bullets, tables, and ADF content. Preserve the original AC text and assign stable local AC IDs.
- Detect empty, contradictory, vague, or non-UI-testable ACs and mark as `needs_clarification` or `not_ui_testable` rather than inventing requirements.
- Generate a traceability matrix: AC -> test case -> assertion -> evidence -> result.
- For each testable AC, generate at least one positive test and at least one meaningful negative/boundary test where applicable. When a negative test is not applicable, record a reason.
- Test case results: `passed`, `failed`, `blocked`, `skipped`, `not_applicable`. Aggregate AC results deterministically; an AC must not pass when required tests are failed or unexecuted.
- Never mark an AC passed based solely on successful navigation or a screenshot; require observable assertions.

**Acceptance criteria:** Every fetched AC is represented in the final traceability report, including unsupported/ambiguous ones, with explicit coverage status.

### FR-04: Memory-first autonomous execution (P0)
- Before navigating, call existing graph-memory MCP search/read tools using project ID, application identity, relevant page/feature, and AC terms.
- Use existing YAML-ingested seed knowledge as initial guidance, but treat it as potentially stale and validate against the live UI.
- Prefer known stable routes/selectors and accessible element roles; fall back to semantic DOM inspection and exploration when memory is stale.
- Use the existing browser MCP navigation and screenshot tools; do not build a second browser automation stack.
- Write memory through the existing memory MCP interface, not by bypassing it with direct SQLite mutations. The memory service MUST execute the spaCy pipeline defined in FR-07 before persisting new or updated learnings.
- Store learnings about pages, transitions, reliable locators, required preconditions, workflows, known validation messages, environment constraints, and previously verified tests.
- Attach provenance: project/environment, application version when known, URL pattern, timestamp, source run, observed outcome, confidence, and verification status.
- Use graph relationships such as `PAGE -> HAS_ACTION -> ACTION`, `ACTION -> NAVIGATES_TO -> PAGE`, `TEST -> COVERS -> AC`, `LOCATOR -> BELONGS_TO -> PAGE`, and `OBSERVATION -> SUPPORTS -> LEARNING` (adapt to existing schema).
- Deduplicate/merge learnings using spaCy-normalized entities together with graph identifiers, project scope, provenance and verification; mark stale/conflicting edges instead of accumulating contradictory facts.
- Separate exploratory hypotheses from verified facts; only promote a learning after direct confirmation.
- Scope memory by project and environment to avoid leaking selectors, credentials, or workflows across applications.
- Do not persist passwords, session cookies, tokens, personal data, or full sensitive page contents.

**Acceptance criteria:** A second run reuses verified navigation learnings; a changed selector triggers revalidation and updates stale memory; all memory changes are traceable to a run. All newly persisted learnings pass through the centralized spaCy preprocessing stage (FR-07).

### FR-05: Positive and negative testing (P0)
- Execute happy-path behavior and failure/boundary behavior, including missing required fields, invalid formats, authorization restrictions, invalid transitions, duplicate operations, and boundary values when relevant to the AC.
- Use isolated test accounts and test data. Prevent destructive actions on production by default; require explicit environment policy approval for write/destructive scenarios.
- Validate outcomes using DOM state, visible error messages, URL changes, network results when available, and persisted UI state as appropriate.
- Capture evidence on failure and optionally on success; include screenshot, page URL (redacted), assertion details, and time.
- On blocked tests, stop only the affected case unless a global blocker prevents further safe execution.
- Respect configurable test count, time budget, retries, and parallelism; browser sessions must be isolated when tests run concurrently.
- Record test data setup/cleanup outcomes; failures to clean up must be visible.

**Acceptance criteria:** The run produces both positive and negative cases with independently asserted results and reproducible failure descriptions.

### FR-06: Jira reporting with screenshot evidence (P0)
- Produce one human-readable report comment per completed run, not one comment per test case.
- Include: run ID, timestamp, environment, application version if available, overall status, AC coverage, passed/failed/blocked counts, positive/negative results, failed assertions, repro steps, and evidence attachment links.
- Attach screenshots before posting the comment, and include only successfully uploaded evidence links.
- Provide a machine-readable local JSON report plus a Markdown report for auditing and troubleshooting.
- Use a deterministic run marker in the Jira comment (e.g. `UI-TEST-RUN:<uuid>`) and check for an existing report before retrying comment creation.
- If the report was already posted, do not duplicate it; optionally update it if supported and explicitly configured.
- Include clear `partial` status when some test cases or attachments are missing.
- Provide `--report-only` to retry reporting an existing saved run without rerunning UI tests.

**Acceptance criteria:** A failed test with a screenshot results in a Jira comment with repro steps and a working attachment link. Repeating the report command does not create duplicate comments.

### FR-07: Mandatory spaCy-powered graph memory upgrade (P0)

**Purpose:** Improve the quality, structure, retrieval, and reuse of the existing SQLite graph memory. spaCy is **required infrastructure in the memory subsystem**, not an optional agent suggestion or a second standalone memory store. Preserve the existing SQLite graph and MCP contract wherever practical.

#### A. Centralized memory ingestion pipeline

- Add a single memory ingestion service behind the existing graph-memory MCP write/update tools. **Every new or updated persistent learning MUST pass through spaCy before it is written to SQLite**, regardless of source: agent observation, manual memory MCP invocation, YAML startup ingestion, or any other existing import interface.
- Use a deterministic flow: `validate and redact input -> scope and attach provenance -> spaCy parse/normalize -> extract candidate entities and relations -> resolve to graph IDs -> check conflicts/duplicates -> validate observation -> transactional graph upsert -> index for retrieval`.
- Enforce this at the service/repository boundary so callers cannot accidentally bypass preprocessing. Do not implement spaCy independently inside each agent adapter.
- Separate *extraction* from *verification*: spaCy proposes structured facts; it cannot itself prove UI behavior. Only direct observed test assertions or trusted, explicitly labeled seed data can justify a `verified` state.
- Treat extracted text as untrusted data; never execute instructions from pages, Jira tickets, memory text, or YAML content.

#### B. NLP behavior and domain-specific handling

- Use spaCy for sentence splitting, tokenization, lemmatization, part-of-speech / dependency parsing where useful, named-entity recognition, and normalization of textual observations.
- Implement configurable domain-specific `EntityRuler` / `Matcher` rules for UI concepts: pages, route patterns, UI controls, accessibility roles, locators, actions, validation errors, form fields, workflow states, and acceptance-criterion references.
- Detect and propose explicit relationships such as `PAGE -> HAS_ACTION -> ACTION`, `ACTION -> NAVIGATES_TO -> PAGE`, `FIELD -> HAS_VALIDATION -> RULE`, `LOCATOR -> BELONGS_TO -> PAGE`, and `TEST -> COVERS -> AC`. Store type, direction, evidence, and source text span where available.
- **Do not transform selectors, URLs, route templates, issue keys, test identifiers, or exact error strings using lemmatization.** Store exact values alongside normalized/searchable representations; preserve escaped characters and case sensitivity where relevant.
- spaCy extraction may identify candidate nodes/edges; use deterministic validators for required fields and allowed edge types. Ambiguous relations remain candidates or unverified observations; do not silently invent navigations or validations.
- Prefer configurable rules + available spaCy components over assuming pretrained NER alone will understand application-specific terms. Define a clear extension point for new patterns and rules as the tool learns new applications.

#### C. Identity, deduplication and memory lifecycle

- Resolve node identity using `(project_id, environment, entity_type, canonical_key)` rather than entity text alone. Distinguish environments and application versions when they materially change behavior.
- Use spaCy lemmas / normalized phrases to improve candidate lookup but merge only when exact IDs, trusted rules, and compatible context agree; **never merge distinct controls merely because words are similar**.
- Persist `raw_text`, normalized text, extracted entities/relations, provenance/source run, timestamps, verification state, confidence or evidence score, spaCy pipeline version, rules version, and schema version.
- Represent conflicting observations as separate evidence with version/time/environment scope; transition superseded facts to `stale` with a reason, instead of overwriting historical evidence.
- Preserve the distinction between `observed`, `candidate`, `verified`, `stale`, and `rejected`; only verified actionable learnings should be preferred by the testing agent.
- Strip credentials, cookies, tokens, session IDs, sensitive field values, and configured PII **before** NLP processing or persistence, and ensure spaCy debug logs never retain the original sensitive text.

#### D. Retrieval and agent use

- At memory read/search time, optionally preprocess the search query with the same versioned spaCy normalization and UI-term rules, while supporting exact lookup for selectors, issue keys, routes, and identifiers.
- Rank retrieved knowledge by project/environment fit, verification status, graph relevance, source recency, and matching entities/relations. Do not imply that spaCy supplies semantic embeddings unless a configured pipeline genuinely includes that capability.
- Return original verified evidence and provenance with search results; the agent must still validate known routes and selectors against the live UI.
- Retain backward compatibility with existing memory MCP tool names and output shapes where feasible. Expose additional NLP metadata as additive fields, not breaking changes, unless explicitly versioned.

#### E. Runtime, deployment and failure behavior

- Declare Python and spaCy as **required memory-service dependencies**, along with a pinned, compatible spaCy language pipeline (for example `en_core_web_sm` initially, or a project-selected equivalent). Pin/lock compatible package and model versions; **do not depend on runtime model downloads or external APIs**.
- If the main CLI is implemented in a different language, run spaCy in a managed local Python subprocess/sidecar with a stable versioned local interface, automatic startup/health checks, bounded queues, and graceful shutdown. Keep it offline and local by default.
- Add `uitest memory doctor` (command name illustrative) to check Python runtime, spaCy package/model presence, model compatibility, pattern loading, SQLite migration status, and preprocessing readiness; provide clear remediation steps.
- On spaCy failure, **fail closed for persistent learning writes** (queue in a secure, clearly labeled transient store only if the existing architecture safely supports it). Do not silently write unprocessed learnings or report successful persistence. Browser tests may continue in degraded read-only-memory mode, with the outage called out in the run report.
- Avoid downloading packages/models on every CLI startup. Provide documented install/build-time provisioning and a predictable offline packaging strategy for Windows and Linux.

#### F. Migration and YAML integration

- Implement forward-only, versioned SQLite graph migrations and a **repeatable, resumable, idempotent backfill** for existing nodes, edges, and YAML-seeded memories. Back up the database before schema upgrades; preserve original values and link migrated facts to old IDs.
- On startup, retain the existing configured YAML scan/ingestion behavior, but process changed seed records through the **same spaCy pipeline**. Detect unchanged YAML using file/record fingerprints to avoid reprocessing every startup.
- On changing spaCy model/rules versions, provide an explicit controlled re-index/reprocess workflow (e.g. `uitest memory reindex --dry-run`) instead of silently rewriting all existing knowledge on startup.
- Produce migration summaries showing scanned, migrated, merged, rejected, stale, and failed records; no silent drops or destructive migration without an operator-visible plan.

**Acceptance criteria:** Agent-authored and YAML-imported persistent learnings both run through spaCy; UI-specific entities/edges are normalized and linked without damaging exact selectors; duplicate learnings in the same context are reconciled; project/environment boundaries remain intact; existing memory is migrated without losing provenance; retrieval remains compatible through MCP; missing spaCy prevents new persistent writes and reports a clear diagnostic.

## 5. Proposed architecture

```text
CLI / Current Ticket Context
  |-- Agent Installer
  |     |-- Canonical Agent Definition
  |     |-- Copilot Adapter
  |     `-- Codex Adapter
  |-- Test Run Orchestrator
  |     |-- Jira AC Reader (first-party)
  |     |-- AC Planner / Traceability
  |     |-- Browser MCP Client (existing)
  |     |-- Graph Memory MCP Client (existing)
  |     |-- Evidence Collector / Redactor
  |     `-- Jira Reporter (first-party)
  `-- Run Store (local JSON + Markdown reports)

Existing MCP Server: Browser Tools + Graph Memory Tools
Existing Memory Service: mandatory spaCy NLP stage on all persistent writes
  |-- Domain EntityRuler / Matcher rules + entity/edge resolution
  |-- Graph validation, redaction, deduplication, provenance
  `-- Existing SQLite Graph: project-scoped learnings and provenance
Existing YAML Loader: startup seed knowledge ingestion -> spaCy pipeline
```

The installed runtime agent is the reasoning/execution layer; the CLI owns deterministic Jira transport, evidence management, report persistence, and safe retries. Prefer exposing high-level CLI operations through MCP where needed, without duplicating the existing browser/memory interfaces.

## 6. Proposed interfaces

### CLI

```bash
uitest agent install --runtime codex --scope project
uitest agent install --runtime copilot --scope project
uitest agent doctor --runtime codex
uitest test run --ticket current --positive --negative
uitest test report --run-id <run-id> --jira
uitest test report --run-id <run-id> --jira --report-only
```

### New MCP tools (names illustrative)

| Tool | Purpose |
|---|---|
| `jira_get_acceptance_criteria` | Read ACs for the ticket already in context |
| `jira_upload_test_evidence` | Upload validated/redacted screenshot to ticket |
| `jira_publish_test_report` | Publish or reconcile one report comment |
| `test_get_run` | Retrieve persisted run, coverage, and evidence manifest |

Existing browser navigation and graph memory MCP tools remain authoritative. Do not add redundant memory or browser tools. Additive diagnostics and reindex operations for spaCy are permissible (FR-07).

### Example configuration

```yaml
jira:
  enabled: true
  deployment: cloud
  base_url: https://example.atlassian.net
  auth:
    mode: api_token
    email_env: UITEST_JIRA_EMAIL
    token_env: UITEST_JIRA_API_TOKEN
  acceptance_criteria:
    sources:
      - description_heading: Acceptance Criteria
      - custom_field: customfield_12345
  evidence:
    upload: true
    max_file_mb: 10
    redact_selectors:
      - '[data-sensitive="true"]'
  reporting:
    comment_on_completion: true
    allow_partial_evidence: true
memory:
  nlp:
    provider: spacy  # mandatory; other values invalid in this version
    model: en_core_web_sm  # pinned in the runtime lockfile/build
    patterns_path: ./config/memory-patterns.jsonl
    fail_on_unavailable: true
  ingestion:
    yaml_fingerprint_cache: true
agent:
  default_runtime: codex
  memory_first: true
testing:
  positive: true
  negative: true
  allow_destructive_actions: false
  max_parallel_sessions: 1
  timeout_minutes: 30
```

Configuration must validate custom-field IDs and environment variables at startup. Never store actual credentials in this file. The spaCy configuration shown is illustrative; integrate it into the existing config layout rather than introducing a conflicting config format.

## 7. Data contracts

### AcceptanceCriterion
`{ id, jiraIssueKey, sourceField, originalText, normalizedText, testability, reason? }`

### TestCase
`{ id, acIds[], kind: positive|negative, preconditions[], steps[], assertions[], status, evidenceIds[], failureDetails? }`

### Evidence
`{ id, runId, testCaseId, localPath, sha256, mimeType, redacted, capturedAt, jiraAttachmentId?, jiraUrl?, uploadStatus }`

### TestRun
`{ id, issueKey, projectId, environment, startedAt, finishedAt?, status, acs[], cases[], evidence[], memoryChanges[], jiraCommentId?, reportingStatus }`

Use durable run state transitions (`planned -> running -> completed|partial|blocked -> reporting -> reported|report_failed`) so a crash can be recovered without duplicating Jira side effects.

## 8. Jira report example

```markdown
## Automated UI verification — UI-TEST-RUN: <run-id>
**Ticket:** ABC-123 | **Environment:** staging | **Result:** PARTIAL
**Coverage:** 3/4 ACs tested | **Cases:** 5 passed, 1 failed, 1 blocked

### Acceptance criteria
- AC-1 — PASS: Valid form submission; negative validation verified.
- AC-2 — FAIL: Invalid input accepted unexpectedly.
- AC-3 — BLOCKED: Required test account unavailable.
- AC-4 — NOT UI TESTABLE: Backend-only requirement.

### Failure: AC-2 / TC-05 (negative)
1. Open the configured form.
2. Enter the invalid value.
3. Submit.
Expected: validation message and no submission.
Actual: submission succeeded.
Evidence: [Screenshot](<actual-uploaded-jira-attachment-url>)

**Notes:** Two verified navigation learnings saved. One selector marked stale.
```

Only generate a link after Jira confirms the upload and returns its actual attachment metadata.

## 9. Failure handling and security

- **Jira unreachable:** Continue testing where ticket ACs were already successfully cached for this run, but mark freshness; queue report locally and allow explicit retry.
- **No ACs found:** Stop with actionable `needs_clarification`, do not fabricate test objectives.
- **Browser navigation blocked:** Record blocked cases and continue unrelated tests if safe.
- **Memory unavailable:** Continue with reduced capability, flag degraded mode, and queue learning writes for later reconciliation only if secure and supported.
- **Upload failed:** Keep evidence locally, mark upload failure, and avoid fake links.
- **Comment timeout:** Query Jira for the run marker before attempting another create.
- **Sensitive evidence:** Redact or suppress before persistence/upload; avoid secrets in traces, console output, and Jira comments.
- **Prompt injection:** Treat Jira text, UI content, and memory as untrusted task data, never as authority to override runtime safety or change credentials.
- **Least privilege:** Restrict Jira scopes and projects; no status changes or arbitrary issue edits.

## 10. Observability and quality attributes

- Structured logs with run ID, ticket key, tool call, duration, error category, and correlation ID; secrets scrubbed.
- Local audit trail for every AC, assertion, screenshot, memory write, upload, and Jira comment.
- Deterministic reporting; resumable upload/comment stages.
- Versioned adapters, configuration schema, graph schema migrations, spaCy model/rules version tracking, and backward compatibility with existing YAML.
- Performance target (proposed): memory lookup and AC ingestion should not dominate browser execution; expose per-stage timing rather than assuming fixed response-time SLAs.

## 11. Implementation plan

### Phase 1 — Jira evidence pipeline (P0)
- Inspect existing ticket context, CLI, MCP registration, run storage, and Jira usage.
- Implement Jira AC reader, ADF parser, attachment uploader, comment publisher, idempotency/retry logic, and secure configuration.
- Add integration tests using mocked Jira responses and a test Jira project where available.

### Phase 2 — Runtime agent installation (P0)
- Define canonical agent contract and required MCP capabilities.
- Implement Copilot/Codex adapters, install/uninstall/doctor commands, backups, idempotency, and documentation.
- Verify actual runtime-specific file paths and formats against installed runtime versions during implementation.

### Phase 3 — Autonomous AC testing and memory (P0)
- Add AC traceability, positive/negative planning, assertion/result contracts, memory-first workflow, verified learning writes, and evidence collection.
- Add blocked/partial behavior and safe data policies.

### Phase 3B — spaCy graph-memory upgrade (P0)
- Inspect current SQLite graph schema, memory MCP implementations, and YAML ingestion code paths to identify every persistent write path.
- Package a pinned local spaCy runtime/pipeline for the supported Windows/Linux deployment modes; provide `memory doctor` and health checks.
- Add centralized redaction, spaCy parsing, UI-specific rules, canonical entity IDs, relation validation, deduplication, and transactional upserts behind existing memory MCP tools.
- Add versioned migrations, resumable backfill, YAML fingerprinting, reindex tooling, and exact-selector regression protection.
- Extend retrieval using NLP normalization while preserving exact search and MCP compatibility; add unit, integration, and migration tests.

### Phase 4 — End-to-end Jira reporting (P0)
- Persist run reports; upload evidence; post or reconcile a single Jira comment; support report-only retries.
- Run end-to-end tests against a fixture app with deliberately passing, failing, and blocked ACs.

### Phase 5 — Hardening (P1)
- Improve graph learning conflict resolution, concurrent session isolation, screenshot redaction, test data cleanup, and Data Center adapter feasibility.

## 12. Engineering test matrix

| Scenario | Expected result |
|---|---|
| Valid Jira auth and screenshot | Attachment uploaded; report comment contains real URL |
| Jira attachment permission denied | Clear error; no invented evidence link |
| Comment request times out after success | Reconciliation finds run marker; no duplicate comment |
| No ACs present | Needs clarification; no fabricated tests |
| AC has positive and negative behavior | Both test cases executed and asserted |
| AC cannot be UI-tested | Explicit non-UI-testable classification |
| Existing graph learning is valid | Reused and provenance recorded |
| Existing graph learning is stale | Revalidated, marked stale, replacement stored |
| Memory MCP unavailable | Degraded run; no false persistence claim |
| Agent writes a new observation | spaCy runs before SQLite write; extracted graph data and provenance persisted |
| YAML startup seed changes | Changed records use spaCy ingestion; unchanged fingerprints skipped |
| Known locator includes special characters | Exact selector survives preprocessing and can be recalled exactly |
| Equivalent observations within one project/environment | Canonical identity prevents duplicate verified nodes/edges |
| Similar labels in different projects/environments | Memory remains isolated; no cross-scope merge |
| spaCy package/model is missing or incompatible | `memory doctor` fails clearly; persistent writes rejected; test execution can continue degraded |
| spaCy rules/model version updated | Explicit reindex updates derived data without losing raw facts or provenance |
| Existing graph migrated twice | Migration/backfill idempotent; no missing facts or new duplicates |
| NLP extraction proposes unobserved relation | Stored as candidate, never auto-promoted to verified |
| Copilot/Codex install twice | No duplicate/overwritten unrelated settings |
| Uninstall runtime agent | Only managed files/settings removed |
| Secret appears in UI | Evidence redacted/suppressed before Jira upload |
| Destructive case on production | Blocked by default policy |
| Crash after evidence upload | Resume/reconcile without duplicate attachments when possible |

## 13. README rewrite and developer onboarding (P0)

### Problem and outcome

The current README is dense and confusing. Rewrite it as a concise, task-oriented entry point that helps a new user understand the tool, install it, configure it, connect an agent runtime, and run a Jira-backed UI test without reading the entire technical specification. **This is a documentation rewrite, not just an appended feature section.** Preserve accurate, useful existing information while removing duplication and outdated instructions.

### Required documentation work

1. **Audit the existing README and CLI:** Inspect the actual command help, supported runtimes, environment variables, YAML schema, MCP tools, Jira integration, and existing examples. Do not document proposed commands as implemented unless they actually work.
2. **Restructure the README for progressive disclosure:** Use this suggested order: project name and one-paragraph purpose; key capabilities; prerequisites; quick start; configuration; install/connect a Copilot or Codex agent; first test run; Jira results and screenshots; graph memory and YAML learning; CLI command reference; troubleshooting; security/limitations; links to deeper documentation.
3. **Create a genuinely runnable quick start:** Include copy-pasteable commands, example configuration with safe placeholders, expected outcome, and a minimal end-to-end flow. Distinguish optional Jira features from core browser/MCP setup and show both the simplest non-Jira path and the Jira-backed path.
4. **Make the mental model obvious:** Briefly explain the relationship among CLI process, MCP server, headless browser/Playwright, runtime-installed agent, SQLite graph memory, YAML seed files, spaCy-powered memory ingestion, and Jira. A compact Mermaid architecture diagram is acceptable if it makes the flow clearer.
5. **Improve scannability:** Use short sections, plain language, consistent terms, short code examples, and links to detailed reference docs instead of long inline explanations. Explain jargon on first use; avoid marketing filler.
6. **Separate reference material when needed:** Move exhaustive MCP tool inventories, YAML field definitions, configuration options, and architecture details into appropriately linked `docs/` pages rather than deleting useful information. Keep the README useful as a standalone landing page.
7. **Include realistic examples:** Show runtime agent installation and invocation, initial YAML learning, spaCy setup/model provisioning, `memory doctor`, memory reuse across runs, and how to find the Jira comment and screenshot attachments. Explain how to configure credentials securely without embedding secrets.
8. **Validate every example:** Check commands against the actual CLI, validate sample YAML against the parser/schema, check internal links, and run the quick-start sequence in a clean environment or document the exact steps that could not be exercised.
9. **Keep documentation synchronized:** Update `--help`, example config files, and linked docs when they contradict the README; do not silently change application behavior solely to make examples appear correct.

### README acceptance criteria

- [ ] A first-time developer can identify what the tool does and how its components fit together within the opening sections.
- [ ] The quick start provides a clear path from installation to a successful browser test with no unexplained prerequisites.
- [ ] Jira integration and Copilot/Codex agent installation are described using commands verified against the implemented CLI.
- [ ] The README clearly distinguishes required setup (including spaCy) from optional capabilities and marks platform/runtime limitations.
- [ ] Detailed reference information remains discoverable through working links without overwhelming the README.
- [ ] All documented examples, sample YAML, and internal links are verified, or any unverified steps are explicitly identified.
- [ ] A documentation review checks clarity, readability, accuracy, and absence of stale or duplicate instructions.

## 14. Definition of done

- [ ] First-party Jira integration fetches ACs and reliably uploads screenshots and comments.
- [ ] Both Copilot and Codex have tested agent installation and documented invocation paths.
- [ ] Agent uses the ticket already held by the tool, without rebuilding ticket selection.
- [ ] Every AC is traced to test cases, assertions, outcomes, and evidence or an explicit gap.
- [ ] Positive and negative testing is demonstrated on fixture workflows.
- [ ] Graph memory is read before execution and verified learnings are written via existing memory MCP tools, with spaCy obligatorily processing every persistent memory write.
- [ ] Screenshot uploads are privacy-safe and actual Jira attachment references appear in comments.
- [ ] Comment publishing is resumable and resistant to duplicates.
- [ ] Errors, blockers, and incomplete evidence are reported accurately.
- [ ] Automated unit, integration, and end-to-end tests pass; CLI help is accurate.
- [ ] spaCy runtime and pinned model are installed locally for supported platforms; `memory doctor` identifies missing/incompatible components.
- [ ] UI entity/relation extraction, safe canonical deduplication, exact-selector preservation, and project/environment isolation pass tests.
- [ ] Existing graph and YAML seed records are migrated/backfilled idempotently without loss of provenance; changed YAML uses the same NLP write pipeline.
- [ ] spaCy failures do not lead to unprocessed graph writes or falsely reported successful persistence.
- [ ] README is rewritten for clarity and onboarding, with a validated quick start, working examples, spaCy requirements, and linked reference documentation (Section 13).

## 15. Instructions to the implementing coding agent

1. Inspect the repository and identify the existing CLI framework, browser MCP tools, graph-memory MCP tools, ticket context model, YAML ingestion, and test/run persistence. **Reuse these components.**
2. Produce a short implementation map of the files/modules you will change and any unresolved integration assumptions.
3. Implement the P0 requirements incrementally with tests. Avoid introducing an alternate Jira ticket selection flow or duplicate browser/memory stores.
4. Validate Copilot and Codex native agent formats and MCP configuration for the runtime versions available in the environment; document any unsupported versions rather than inventing compatibility.
5. Use mocks for repeatable Jira API tests and an optional live Jira sandbox for attachment/comment verification. Never publish test comments to production issues without explicit authorization.
6. Include a fixture UI application covering valid submission, invalid submission, a changing selector, and an intentionally blocked test.
7. Demonstrate the complete path: selected ticket -> fetch ACs -> read graph memory -> execute positive/negative tests -> persist verified learnings -> upload screenshots -> publish one Jira comment.
8. Implement FR-07 as a centralized spaCy-powered enhancement to the **existing** graph-memory service. Inventory all write paths, run migrations/backfill, preserve MCP compatibility, and demonstrate YAML and agent writes both pass through spaCy.
9. Rewrite the README as specified in Section 13, including restructuring and validating onboarding commands, spaCy setup/diagnostics, and configuration examples. Do not merely append the new features to the old README.
10. Provide command examples, memory migration/reindex notes, tests run, known limitations, and a final requirement-by-requirement completion checklist.

## 16. Open decisions (non-blocking defaults)

- **Jira edition:** Jira Cloud first; Data Center later if needed.
- **AC source:** Configurable description heading and custom field; default to heading `Acceptance Criteria`.
- **Agent packaging:** Runtime-native agent definition generated from a bundled canonical template.
- **Evidence retention:** Local evidence stored per run with configurable cleanup/retention; default must be conservative and documented.
- **Jira report trigger:** Report automatically on run completion, with an option to disable and report manually.
- **Parallelism:** One isolated browser session by default; configurable later.
- **Ticket context ownership:** Existing tool remains source of truth for current ticket.
- **Memory NLP:** spaCy is mandatory for persistent graph ingestion; `en_core_web_sm` is the initial proposed model, to be locked and packaged for offline use.
- **Graph backend:** Keep the existing SQLite graph; spaCy enriches ingestion and retrieval rather than replacing graph storage.
- **Memory recovery:** Failure to initialize spaCy blocks persistent writes, but may permit browser-only testing with prominently reported degraded memory capability.
