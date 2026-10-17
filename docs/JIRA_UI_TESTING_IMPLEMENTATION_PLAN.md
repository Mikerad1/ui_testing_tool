# Jira-Integrated UI Testing Enhancements — Implementation Plan

**Source:** `docs/ui_testing_tool_enhancement_prd.md` (v1.2)<br>
**Status:** Phase 0 closed after Oracle approval. Phases 1A and 1B closed after their gates; Phase 1C remains in progress.<br>
**Last updated:** 2026-10-17

This plan sequences the PRD into reviewable delivery phases. Update the status and evidence below when a phase passes its tests and review gate; do not mark a phase complete based only on code being present.

## Confirmed contracts and constraints

- The executable is `umb`; proposed `uitest` commands must use `umb` names.
- Every Jira acceptance-criteria (AC) read operation requires an explicit agent-supplied `issue_key`. There is no implicit lookup, discovery, or ticket selection. Bind that same key to the persisted run and its report so the tested issue is traceable end to end.
- The reusable testing agent is installed in each runtime's native agent/skill format. The runtime is the reasoning/execution layer and calls UMB over MCP.
- UMB owns first-party Jira transport for AC reads, screenshot uploads, and report comments. The runtime's generic Jira MCP is not the evidence-reporting path because it cannot reliably create screenshot-backed/inline comments.
- Keep the existing SQLite graph, browser MCP, Playwright controller, YAML knowledge, and MCP names/contracts where practical. Do not create alternate browser or memory stores.
- spaCy is mandatory for every new/updated persistent graph learning, including MCP-authored and YAML-imported learnings. Failure to preprocess must fail closed for learning writes.
- Jira Cloud is first; comments may use inline attachment rendering only where the Jira Cloud format is verified. Otherwise include links to actual confirmed attachments.
- Preserve unrelated existing work and configuration. Never publish to production Jira without explicit authorization.

## Phases and exit gates

| Phase | Status | Scope | Exit gate |
| --- | --- | --- | --- |
| 0. Repository and interface refinement | Closed — Oracle approved | Map current CLI/MCP/memory/browser/YAML/run architecture; confirm runtime-provided issue-key flow and UMB-owned Jira evidence reporting; identify decisions that need validation. | Implementation map and ownership boundaries recorded below; all Oracle findings reconciled and approved (see progress log). |
| 1. Mandatory spaCy memory foundation | In progress — Phases 1A–1B closed; Phase 1C pending | Provision pinned Python, spaCy and model offline in platform-specific Node CLI release bundles; implement versioned local NLP sidecar and health diagnostics; enforce one spaCy-processing repository boundary for every persistent learning-node/edge write, including MCP and YAML reconciliation; redact sensitive data before it reaches spaCy; preserve exact identifiers; add provenance, scope, safe deduplication, migrations/backfill, record-level YAML fingerprints and explicit reindex. Keep operational run/assertion/evidence persistence distinct from learning writes. | Before migration work/schema changes, implement and test a SQLite-consistent backup AND restore method appropriate to WAL mode; a plain database-file copy is not sufficient. Preserve/link old IDs, raw/original values and provenance; provide an operator-visible migration summary; verify integrity; make backfill resumable and idempotent. Every learning-node/edge persistence path must redact sensitive content before sidecar processing and preprocess through the spaCy-enforcing repository boundary before SQLite persistence; spaCy failure rejects learning writes. Tests prove redaction precedes processing and sidecar logs do not retain raw sensitive text. YAML reconciliation fingerprints each file and record: skip unchanged seed records and reprocess changed records; test both behaviors (current whole-file hashing alone does not satisfy record-level behavior). Persistent learning writes remain disabled until pinned spaCy and model are bundled and packaged offline health/write tests pass on every supported release target. Bundles provide platform-specific runtimes/environments with no runtime dependency on ambient Python/PATH, venv creation or network downloads. Exact selectors and project/environment isolation are tested. |
| 2. First-party Jira client and AC reads | Not started | Strict Jira config and secret references; Cloud client; require explicit agent-supplied `issue_key` on every AC-read operation, with no implicit lookup/discovery/selection; ADF and configured-source parsing; stable AC IDs, source references and retrieval timestamps; bind the same key to the persisted run/report; actionable error categories. | Mocked tests prove AC extraction, explicit-key enforcement and permission/network/rate-limit behavior; persisted run/report retain the supplied key; no ticket selection or secret leakage. |
| 3. Native Copilot/Codex agent installation | Not started | Canonical versioned agent/skill instructions; runtime-native adapters; `umb agent list/install/uninstall/doctor`; scope, dry-run, backup, atomic/idempotent writes and safe MCP config integration. | Each supported installed runtime can invoke the agent and call UMB; repeated install/uninstall preserves unrelated files and settings. |
| 4. Traceable autonomous AC testing | Not started | Durable run/AC/test-case/assertion/evidence contracts; AC planning and deterministic aggregation; memory-first agent workflow; existing browser MCP execution; verified learning writes; blocked/partial and destructive-action policies. | Fixture app proves positive, negative, failed, blocked, stale-selector and non-UI-testable outcomes; no AC passes without required assertions; second run reuses verified memory. |
| 5. Jira evidence and report lifecycle | Not started | Redacted evidence manifest; screenshot upload before one ADF report comment; actual attachment references only; deterministic run marker and reconciliation; bounded retry and report-only recovery; JSON/Markdown reports. | Mocked APIs and fault injection prove permission handling, no false links, crash recovery and no duplicate comments. Verify inline rendering in an authorized Jira Cloud sandbox; use real links if inline rendering is unsupported. |
| 6. End-to-end hardening, release and onboarding | Not started | Full fixture-to-Jira flow; privacy, cleanup, recovery and concurrency hardening; repeat/extend Phase 1 offline packaging validation for Windows/Linux release targets; rewrite README and linked references; validate all examples. | Node and Python tests, build/typecheck/lint, packaging checks, CLI help, YAML/config/link checks and a clean quick start pass or have explicit limitations documented. Phase 6 does not defer the Phase 1 packaging gate. |

### Dependency order

Phases 1A and 1B are closed: WAL-consistent backup/restore to fresh inactive paths and the redacted, spaCy-enforced ingestion boundary are implemented and gated; in-place replacement is excluded. Phase 1C remains in progress. Phase 1 and the Jira AC-read portion of Phase 2 can proceed in parallel after their interfaces are fixed. No persistent learning writes are enabled until the full Phase 1 exit gate—including tested SQLite-consistent backup/restore, redaction, record-level YAML fingerprints, offline packaging and write/health tests—passes on every supported release target. Phase 3 can begin once MCP tool contracts are stable. Phase 4 depends on Phases 1–3; Phase 5 depends on Phases 2 and 4; Phase 6 closes the complete flow and repeats release validation. The spaCy write path must be ready before agent-authored learnings are enabled.

### Phase 1 offline packaging research (complete; implementation in progress)

Recommendation: provision a pinned Python environment, spaCy and language model at build time, and bundle a platform-specific environment/runtime in each Node CLI distribution. Prefetch artifacts and verify hashes during provisioning; runtime is offline-only and must fail clearly when the bundled runtime or model is unavailable. `spacy download` uses pip and is provisioning-time only, never a runtime operation. Test installation and runtime with networking disabled, separately for each supported Linux/Windows target. Select and validate the Node bundling mechanism against the current release packaging; the research does not prescribe one.

Official documentation confirms 64-bit CPython platform support and records Python 3.13 support in spaCy 3.8.7 and Python 3.14 support in 3.8.9. The English model documentation lists `en_core_web_sm` 3.8.0 as an example, not as an approved compatible pin. Exact Python/spaCy/model/OS/architecture combinations remain candidates until validated in CI before pinning. Sources: [spaCy usage](https://spacy.io/usage), [English models](https://spacy.io/models/en), [installing and loading models](https://spacy.io/usage/models), [spaCy CLI](https://spacy.io/api/cli).

## Existing implementation map

- `src/cli/index.ts`: Commander CLI entry point and existing `umb` command tree.
- `src/config/config.ts`: strict Zod configuration schema; Jira and NLP settings are not present.
- `src/mcp/server.ts`: browser and `memory_*` MCP tool registration; no Jira tools currently.
- `src/memory/store.ts`: SQLite graph and transactional migrations (schema v10), current learning and run/evidence persistence.
- `src/knowledge/reconcile.ts` and `src/knowledge/watcher.ts`: YAML validation/reconciliation and startup/watch ingestion; reconciliation currently writes graph data directly to SQLite.
- `src/browser/controller.ts`: existing Playwright browser, navigation, assertions, screenshots and artifacts; reuse rather than add a browser stack.
- `src/workflow/runner.ts`: deterministic YAML-authored workflow replay; useful foundation, but not a substitute for AC-driven autonomous planning.
- `src/cli/doctor.ts`: current CLI diagnostics; extend/add memory readiness checks without changing existing doctor semantics unexpectedly.
- `scripts/package-release.mjs` and `.github/workflows/release.yml`: current Windows/Linux bundles include Node, not a Python/spaCy runtime or model.
- Existing tests include memory, migrations, YAML reconciliation/watch, MCP, browser and workflow integration suites. Add focused Jira, NLP, adapter and fixture E2E coverage.

Likely new module boundaries (final names subject to implementation review): `src/memory/ingestion.ts`, a Node sidecar client, a local Python spaCy service/package, `src/jira/*`, `src/agent/*`, and `src/testing/*`.

## Verification and safety rules

- Preserve the current MCP compatibility tests and existing workflow behavior.
- Test all learning write paths through the same spaCy-enforcing repository boundary: MCP proposal/edge/lifecycle operations, YAML initial import/reload/watch/reconciliation, and future agent writes. Keep operational assertion/run/evidence writes distinct unless explicitly modeled as learning.
- Redact sensitive data before sending text to the spaCy sidecar; test that redaction occurs before processing and that sidecar logs never retain raw sensitive text (PRD § data privacy, line 160).
- YAML file/record fingerprints must skip unchanged seed records and reprocess changed records; test both cases. Whole-file hashing alone is insufficient for record-level reconciliation (PRD lines 180–181).
- Before any schema migration, implement and test SQLite-consistent backup and restore for WAL mode; a plain database-file copy is not sufficient. Before/after checks cover row counts, foreign keys/integrity, preserved or linked old IDs and raw/original values, provenance, operator-visible summary, repeat runs, interruption/resume, exact selectors, and cross-project/environment isolation.
- Offline packaged health and learning-write tests must pass with networking disabled for every supported release target before enabling persistent learning writes; do not rely on ambient Python/PATH or runtime environment creation/downloads.
- Jira API tests use mocks by default. Live sandbox checks require explicit authorization; never test comments against production issues.
- Only add attachment URLs/inline references after Jira confirms upload metadata. On uncertain redaction, suppress upload and report evidence as incomplete.
- Current suite commands: `npm run build`, `npm run typecheck`, `npm test`, and `npm run lint`; add Python/packaging checks when the sidecar lands.
- Rewrite README after command/config behavior stabilizes, but update relevant docs and help alongside each implementation phase.

## Progress log

- [x] Phase 0 implementation — repository map and interface clarification recorded; agent supplies issue key, UMB owns Jira evidence transport, and the executable remains `umb`.
- [x] Phase 0 Oracle review — approved after reconciling the original findings and the three additional requirements (WAL-consistent backup/restore, pre-NLP redaction, and record-level YAML fingerprints); Phase 0 is closed.
- Baseline: `npm test` passed (125 passed, 0 failed, 8 skipped for unavailable local browser/platform coverage); `npm run build`, `npm run typecheck`, and `npm run lint` passed. Local Python is 3.14.6; spaCy and `en_core_web_sm` are not installed. These are baseline checks, not feature acceptance evidence.
- [x] Phase 1 packaging research — recommendation, constraints, caveats and official sources recorded; exact supported combinations still require CI validation.
- [x] Phase 1A — WAL-consistent backup and restore to new inactive paths; full suite (130 passed, 8 skipped), typecheck, build and lint passed; Oracle Gate 1 approved after exceptional review (see `.slim/deepwork/jira-ui-testing/phase1a-gate.md`). No in-place restore; Windows/Linux hard-link validation remains in Phase 1C.
- [x] Phase 1B — implement mandatory spaCy sidecar and redacted centralized learning-write boundary; Oracle Gate 1B passed. Actual spaCy/model runtime and offline release readiness remain unvalidated.
- [ ] Phase 1C — implement migration/backfill, trusted environment identity and record-level YAML fingerprints, then pass offline packaging/health/write gates. Persistent learning writes remain disabled until all Phase 1 gates pass.
- [ ] Phase 2 — Jira Cloud client and AC read contract.
- [ ] Phase 3 — Copilot/Codex agent/skill adapters and installer.
- [ ] Phase 4 — AC traceability and autonomous execution.
- [ ] Phase 5 — Jira evidence/report lifecycle.
- [ ] Phase 6 — end-to-end verification, packaging, hardening and README rewrite.
