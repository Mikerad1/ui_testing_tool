# Desktop/browser parity follow-ups

**Status date:** 2026-10-26

**Baseline:** `feature/desktop-visual-testing` at `d69672b` (`feat: expose safe desktop snapshot and URL wait`)

**Checklist introduced:** commit `9efebc0`; first follow-up is in progress.
**Scope:** safe capability parity for an attached `DesktopAdapter` backed by an operator-owned loopback WebDriver session. This list is not a commitment to full `BrowserAdapter` parity.

## How to maintain this list

- Update this file in the same change that completes, blocks, or descopes a listed task. Do not leave a completed task marked open.
- For each completed implementation, record its commit/PR and the focused, full-suite, native, and static checks that actually ran. Native claims must name the tested driver/runtime.
- Keep each capability behind its own safety/feasibility decision, fake/MCP evidence, native evidence where applicable, and narrow independent review. A review of one capability does not approve neighboring capabilities.
- Do not claim support from protocol standards alone. Preserve the operator-owned session: never create/delete its WebDriver session, switch its active tab, or perform an operation that can implicitly close it without a separate safety decision.
- Reconcile the capability matrix at `.slim/deepwork/desktop-browser-interaction-parity/capability-matrix.md` whenever this list changes.

## Completed baseline (reference; not open work)

- [x] **Bounded desktop `ui_snapshot`** — strict `interactive|compact` input; 500-element traversal and 160-character names; input values omitted; visible page text is not PII-redacted. Fake/MCP and native evidence; narrow Oracle PASS. Native support is limited to tauri-driver 2.1.0/current tested Tauri-WebKit.
- [x] **Desktop URL wait** — strict `url` branch, nonblank substring <=2,048 characters, timeout 1–10,000 ms, matches the sanitized current URL. Returned URL is sanitized; returned title is not. Fake/MCP and native evidence; separate narrow feasibility and implementation Oracle PASS. BrowserProvider behavior and YAML `waits: ['visible']` remain unchanged.
- [x] **Baseline validation at `d69672b`** — focused MCP/adapter 55/55; full suite 465 passed / 13 skipped / 0 failed; native attached acceptance 1/1; typecheck, lint, build, and diff checks passed.

## Next actionable work

### 1. Resolve assertion failure-capture privacy boundary — **COMPLETE**

The previous desktop `test_assert` failure path could persist and return a screenshot artifact. WebView screenshots have no general PII-redaction guarantee, so exposing more assertion predicates could reveal visible user data even when the assertion implementation itself returns only pass/count.

- [x] Choose and document the boundary: failed **direct desktop MCP `test_assert` calls are unconditionally non-capturing**, regardless of `desktop.visual.capture_on_failure`. Return `capture.status='disabled'` and `artifact_ref:null`; preserve failed run/evidence and bounded metadata; skip desktop capture diagnostics. This removes the screenshot blocker only for this direct MCP path. Oracle feasibility review: PASS (`ses_e8887c070ffeCmXhAYmjgNlF9Z`).
- [x] Add tests proving failed `present` and exact-text assertions cannot dispatch a screenshot or return an image/artifact reference; verify the sensitive expected sentinel is absent from response/report metadata, failed evidence persists with null artifact, and persistence failure is sanitized without capture. Focused MCP tests 13/13; full suite 465 passed / 13 skipped; typecheck, lint, build, and diff checks pass.
- [x] Obtain narrow Oracle implementation review: PASS for this failure-capture boundary only (`ses_e8887c070ffeCmXhAYmjgNlF9Z`). BrowserProvider behavior, managed `ui_assert`, and YAML limits remain unchanged. This does not approve additional assertion conditions.
- [ ] Optional test hardening (non-blocking review note): exercise nonempty action history to verify the 30-item projection, and return a sensitive observed-text sentinel from a fake adapter to verify it is never echoed or persisted.

### 2. Re-evaluate additional desktop assertion predicates — **`url_matches` PASS; count held; value unavailable**

The screenshot blocker is resolved for direct desktop MCP `test_assert`, so predicates were reviewed independently. Oracle feasibility review (`ses_e8887c070ffeCmXhAYmjgNlF9Z`) gave `url_matches` a **PASS for feasibility**, `count` a **HOLD** pending an explicit cardinality-disclosure decision and bound, and `value` a **NO** under the general desktop API because it is a boolean oracle for guessed values (including hidden/password-like fields). A separate narrow implementation review PASS approves only the bounded desktop `url_matches` branch.

- [x] Implement only the desktop `url_matches` branch: strict no-target/no-match input with bounded nonblank expected substring, compare against sanitized URL, return only boolean/count, and add fake W3C coverage for URL-only reads, bounded polling, input rejection, and secret exclusion.
- [x] Complete MCP and test-owned native acceptance for the published schema, pre-dispatch rejection, disabled failure capture, same-origin path changes, state/session preservation, and no screenshot. Focused MCP/adapter tests: 58/58; full suite: 468 passed / 13 skipped / 0 failed; native attached acceptance: 1/1, including `mcp-url-assert` on tauri-driver 2.1.0/current tested Tauri-WebKit; typecheck, lint, build, and diff checks pass.
- [x] Obtain narrow Oracle implementation review: PASS for direct desktop MCP `url_matches` only (`ses_e8887c070ffeCmXhAYmjgNlF9Z`). No approval for `count`, `value`, BrowserProvider changes, YAML expansion, or broader parity. Changes remain uncommitted.
- [ ] `count` stays **HOLD** until exact cardinality disclosure is explicitly accepted and a result/expected-count bound is selected; only then request a new safety review.
- [x] `value` is **NO** for a generic CSS API under the current policy; do not implement. Reconsider only if a future proposal includes an independently reviewed allowlist of safe test-owned fields and mitigates the boolean oracle.
- [x] For `url_matches`, complete strict schema/pre-dispatch rejection, exact read-only routes, bounded polling/deadline, no revision/history/context/lifecycle side effects, test-owned native behavior on the named runtime, and its own narrow Oracle implementation PASS. Any future predicate requires the same separate evidence and review.

### 3. Keyboard chord/modifier support — **HOLD**

- Feasibility review: Oracle (`ses_e8887c070ffeCmXhAYmjgNlF9Z`) returns **HOLD** for targeted `ui_press` and targeted `ui_keyboard` chords pending a bounded grammar and native proof of release/timeout recovery; **NO** for page-level chords under the current contract; and **NO** for expanding shared `supportsPressKey`, because it also gates YAML `press` preflight. Official W3C research (Librarian `ses_e87e02c6effe04ml012TNaNw7N`) cites the 2026-07-02 Working Draft, not a Recommendation: Actions key state is session-tracked and Release Actions uses `DELETE /actions`, which the current client allowlist denies. Send Keys NULL (`U+E000`) clears that command's key source and is not interchangeable with Actions release. Protocol behavior does not guarantee OS effects or recovery from an uncertain timeout. Enabling release would need separate review because it affects all depressed inputs in the operator-owned session. Current single-key and YAML behavior remain unchanged; no chord implementation is approved.
- Candidate refinement: a single targeted `Control+A` on a verified text input, encoded through Element Send Keys and terminated by `U+E000`, may avoid general chords and global Release Actions. The test-only native probe on Linux/tauri-driver 2.1.0/current tested Tauri-WebKit verifies the completed chord's event/selection effect, a subsequent unmodified key, and one dispatch returning indeterminate when the response is withheld only after the real command completed. It also characterizes a completed Control-only request followed by a separate `a`, requiring the keydown modifier state to agree with the observed input effect and attempting bounded NULL cleanup. This does **not** test one command interrupted before NULL or establish recovery in that case. The candidate remains **HOLD**; current CSS targeting also does not prove input type or test ownership. If an absolute no-stuck-modifier guarantee is required after every uncertain timeout, the candidate is **NO** under the current shared-session contract. No product implementation is approved.
- [ ] Define a small, explicit, bounded chord grammar and exact behavior for targeted `press` versus page-level `keyboard`; reject ambiguous/unsupported forms before dispatch.
- [ ] Verify ordered key-down/key-up/NULL release encoding, one-dispatch/no-retry indeterminate-timeout behavior, and recovery that cannot leave a modifier stuck.
- [x] Decision: do not expand shared `supportsPressKey` (it also gates YAML `press` preflight); preserve the existing key vocabulary and YAML capabilities. Any future MCP-only chord proposal needs a separate gate and review.
- [x] Add a test-only native probe for successful Control+A/NULL, a response withheld after command completion, and bounded separate-command modifier characterization on tauri-driver 2.1.0/current tested Tauri-WebKit. This is runtime-specific feasibility evidence only; it does not prove safety after interruption before NULL or approve product support.
- [ ] Add fake W3C payload/rejection tests and establish a safe policy for interruption before NULL; obtain separate feasibility and implementation reviews before exposing any chord.

## Keep unavailable unless requirements or safety evidence change

- **`listTabs` — NO under the current contract.** W3C handles do not include each tab's URL; reading inactive-tab URLs requires switching the shared active context. Do not return an incomplete list as though it were complete. Reconsider only if the API contract is deliberately changed (for example, an explicitly handle-only result) and separately reviewed.
- **Tab select/create/close — unavailable.** Selection changes the operator-visible shared context; closing can delete the last browsing context and may terminate the remote session. No tab/window lifecycle operation is permitted by the current ownership contract.
- **Browser diagnostics (`browserErrors`, `consoleErrorCount`) — unavailable.** W3C provides no general console/network diagnostic stream; injected scripts would be partial and miss pre-attach/pre-navigation events. Revisit only with a truthful verified provider stream and native evidence.
- **`actionSequence` — unavailable as a desktop audit source.** Local adapter history cannot represent actions from other clients/operators; do not present it as complete shared-session history.
- **`setViewport` — unavailable.** Native window dimensions are not equivalent to CSS viewport dimensions, and changing the shared operator window has side effects. Any future contract needs precise semantics, ownership/safety review, and native evidence.
- **`setActionTimeout` — unavailable.** Avoid changing global WebDriver timeouts on a session shared with the operator; reconsider only with a demonstrably per-command design.
- **Additional readiness/status fields and waits — not advertised without verification.** Keep unsupported status fields and waits such as `networkidle`/`commit` unavailable until their semantics and target-runtime evidence are separately established.
- **Captured-target approvals/actions — unavailable.** Remote checks cannot lock out external clients or guarantee atomic approval at mutation time. Continue failing closed for configured high-risk actions that require such approval.
- **Full-page/window screenshot parity — unavailable.** Current desktop MCP exposes WebView capture only; do not advertise browser-provider window or full-page semantics without an independent safe implementation and native proof.
- **Full semantic snapshot/find or full `BrowserAdapter` parity — not claimed.** The exposed snapshot is intentionally bounded and does not provide Playwright's richer state/text/ref semantics.
- **General WebKit, other drivers, or other tauri-driver versions — not evidenced.** Add separate native acceptance and review for each target runtime before expanding support claims.
- **Full method-by-method conformance — not established.** Before pursuing broader parity, inventory every `BrowserAdapter` method and require either bounded equivalent behavior or an explicit `CAPABILITY_UNAVAILABLE` result with fake/native evidence as applicable.

## Persistent safety constraints

- Origin checks are best-effort and are not a security boundary; clicks, scripts, redirects, keyboard input, and forms may navigate.
- Keep BrowserProvider behavior unchanged for desktop-only additions.
- Keep YAML workflow capabilities narrower than direct MCP capabilities unless explicitly re-reviewed.
- Never retry a dispatched mutation after an ambiguous timeout; report indeterminate outcomes safely.
- No full-parity or platform-generalization claims.
