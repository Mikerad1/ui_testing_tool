# Desktop/browser parity follow-ups

**Status date:** 2026-10-26

**Baseline:** `feature/desktop-visual-testing` at `d69672b` (`feat: expose safe desktop snapshot and URL wait`)
**Scope:** safe capability parity for an attached `DesktopAdapter` backed by an operator-owned loopback WebDriver session. This list is not a commitment to full `BrowserAdapter` parity.

## How to maintain this list

- Update this file in the same change that completes, blocks, or descopes a listed task. Do not leave a completed task marked open.
- For each completed implementation, record its commit/PR and the focused, full-suite, native, and static checks that actually ran. Native claims must name the tested driver/runtime.
- Keep each capability behind its own safety/feasibility decision, fake/MCP evidence, native evidence where applicable, and narrow independent review. A review of one capability does not approve neighboring capabilities.
- Do not claim support from protocol standards alone. Preserve the operator-owned session: never create/delete its WebDriver session, switch its active tab, or perform an operation that can implicitly close it without a separate safety decision.
- Reconcile the capability matrix at `.slim/deepwork/desktop-browser-interaction-parity/capability-matrix.md` whenever this list changes.

## Completed baseline (reference; not open work)

- [x] **Bounded desktop `browser_snapshot`** — strict `interactive|compact` input; 500-element traversal and 160-character names; input values omitted; visible page text is not PII-redacted. Fake/MCP and native evidence; narrow Oracle PASS. Native support is limited to tauri-driver 2.1.0/current tested Tauri-WebKit.
- [x] **Desktop URL wait** — strict `url` branch, nonblank substring <=2,048 characters, timeout 1–10,000 ms, matches the sanitized current URL. Returned URL is sanitized; returned title is not. Fake/MCP and native evidence; separate narrow feasibility and implementation Oracle PASS. BrowserProvider behavior and YAML `waits: ['visible']` remain unchanged.
- [x] **Baseline validation at `d69672b`** — focused MCP/adapter 55/55; full suite 465 passed / 13 skipped / 0 failed; native attached acceptance 1/1; typecheck, lint, build, and diff checks passed.

## Next actionable work

### 1. Resolve assertion failure-capture privacy boundary — **BLOCKED / design and safety review required**

The desktop `test_assert` failure path can persist and return a screenshot artifact. WebView screenshots have no general PII-redaction guarantee, so exposing more assertion predicates can reveal visible user data even when the assertion implementation itself returns only pass/count.

- [ ] Choose and document a safe failure-output boundary before expanding assertion conditions. Consider a non-capturing desktop assertion result or another demonstrably safe policy; do not assume screenshots are redacted.
- [ ] Add tests proving a failed sensitive-value assertion cannot persist or return a screenshot/image/artifact reference or expose the observed value in results/errors. Cover cleanup and failure behavior.
- [ ] Obtain a separate safety/feasibility review for the chosen boundary. Keep BrowserProvider behavior and YAML assertion capabilities unchanged unless separately approved.

### 2. Re-evaluate additional desktop assertion predicates — **HOLD until item 1 passes**

Consider each predicate independently; do not expand all assertions as a single parity claim.

- [ ] `url_matches`: strict no-target branch, bounded nonblank substring, compare only the sanitized URL, return only safe status/count, and prove query/fragment/credential secrets are absent from outputs/errors.
- [ ] `count`: strict CSS target and bounded non-negative expected count; exact cardinality/polling/deadline semantics; return no page text or values.
- [ ] `value`: strict CSS target, bounded expected value and explicit exact/contains semantics; compare locally and never return the observed value. Treat it as a boolean oracle and retain screenshot/output protections from item 1.
- [ ] For every predicate selected: test schema/pre-dispatch rejection, exact read-only routes, bounded polling/deadline, no revision/history/context/lifecycle side effects, test-owned native behavior on the named runtime, and obtain its own narrow Oracle implementation PASS.

### 3. Keyboard chord/modifier support — **HOLD**

- [ ] Define a small, explicit, bounded chord grammar and exact behavior for targeted `press` versus page-level `keyboard`; reject ambiguous/unsupported forms before dispatch.
- [ ] Verify ordered key-down/key-up/NULL release encoding, one-dispatch/no-retry indeterminate-timeout behavior, and recovery that cannot leave a modifier stuck.
- [ ] Decide explicitly whether expanding `supportsPressKey` also expands YAML `press` preflight. Preserve current YAML capability limits unless separately approved.
- [ ] Add fake W3C payload/rejection tests and native effect/no-stuck-modifier tests on tauri-driver 2.1.0/current tested Tauri-WebKit; obtain separate feasibility and implementation reviews before exposing any chord.

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
