# Tauri / Playwright Useful-Surface Parity Plan

## Objective

Close the gap between UMB's useful Playwright browser-testing/MCP/workflow surface and its Tauri app-testing surface, only where comparable semantics exist. Preserve `browser_*` as Playwright-backed browser tools. Tauri is a distinct, explicitly selected `tauri-driver` backend that controls only its owned configured app session. This is not a goal to reproduce the full Playwright API on desktop or claim unsupported browser semantics. The desktop-visual foundation below is already delivered; the forward roadmap prioritizes bounded YAML workflow execution on Tauri. Source edits and visual judgment remain with the connected coding agent.

## Current parity gap matrix

Status vocabulary: **FULL**, **PARTIAL**, **UNSUPPORTED**, **NOT_APPLICABLE**. Statuses describe the existing Tauri backend, not the target roadmap. Acceptance criteria are observable and backend-specific; parity is not claimed solely because two tools have similar names.

| Capability | Current Tauri status | Observable current behavior / acceptance |
|---|---|---|
| Session lifecycle | PARTIAL | Configured Tauri binary plus owned `tauri-driver` session only; no arbitrary attach. Start/status/stop affect only the managed session. |
| Direct navigation/history controls | UNSUPPORTED | No desktop MCP route, direct navigation, back, or forward controls. UI-driven app state changes are not direct navigation parity; preflight rejects route requirements unless an equivalent is approved. |
| Browser tabs | NOT_APPLICABLE | A single managed native app is not a browser-tab model. Do not synthesize browser tab IDs or switching. |
| Viewport/window size | PARTIAL | Native window resize can be refused by the backend; temporary capture sizing restores the full prior rect. Report refusal and verify restoration. |
| Locators/semantic tree | PARTIAL | Bounded DOM-derived tree/details and CSS selectors only. No browser role/label/placeholder/test-id targets or snapshot refs. Unique CSS resolution is required. |
| Interactions | PARTIAL | Click/type/keypress/scroll only; no desktop fill/select/upload. WebKitGTK behavior varies by build; unsupported actions must fail before effects. |
| Waits/assertions | PARTIAL | present/visible/hidden/enabled waits and assertions, plus exact/contains text assertions. No URL/count/value conditions or URL waits; reject those rather than emulate. |
| Screenshots/masks/visual evidence | PARTIAL | WebView and managed exact-title X11 screenshots, baselines/comparisons/findings. Configured selector masks are narrow DOM overlays, not PII redaction; no full-page equivalence. Wayland window capture and Windows native window capture unsupported. |
| Tauri YAML workflow execution | UNSUPPORTED | No Tauri workflow adapter exists; `test_run_workflow` remains browser-only. |
| Workflow desktop failure screenshot | PARTIAL | `desktop_screenshot` is opt-in diagnostic evidence only; not desktop workflow execution. |
| Upload | UNSUPPORTED | No desktop upload action. Browser upload remains a separate project-root-contained regular-file operation (<=20 MiB) to a unique file input. |
| Diagnostics | PARTIAL | Desktop status/tree/details/failure screenshot exist; no equivalent desktop console/network errors tool. |
| Memory/evidence/reporting | PARTIAL | Shared graph/reporting and separate desktop visual evidence; caller-authored findings only. No automatic visual finding or desktop memory bridge; screenshot evidence has its own retained artifact ref. |
| Auth/security | PARTIAL | Explicit managed app opt-in and baseline server approver plus caller attestation; not browser-origin/target-revision approval parity. Auth safe flows suppress failure capture; workflow failure capture never auto-starts desktop. |
| Platforms | PARTIAL | Capability discovery; WebView needs configured driver. X11 window capture needs exact title, `wmctrl`, and ImageMagick. Wayland window capture and Windows native window capture unsupported; fail without whole-desktop fallback. |

The PRD's execution-backend matrix defines the same status vocabulary and portable workflow semantics. A capability becomes FULL only after matching observable contract tests and supported-runtime evidence; full Playwright API parity is explicitly out of scope.

## Repository fit and boundaries

- Configuration remains in strict, backwards-compatible `umb.config.yaml` parsing (`src/config/config.ts`). Desktop launch is disabled unless explicitly configured; project inspection is read-only and never runs project commands.
- Desktop tools register in the existing per-MCP-session server (`src/mcp/server.ts`) and use structured errors/results. Existing `browser_*`, memory, and Jira tools keep their signatures and behavior.
- Desktop sessions use a dedicated adapter/service boundary; they do not reuse Playwright as a controller for Tauri's Linux WebKitGTK window.
- Browser artifacts already have project-root validation, a private `.umb-managed` directory, quotas, and retention. Desktop captures should follow those controls rather than create a parallel artifact root.
- Memory remains the existing project graph and LearningWriter/spaCy pathway. This first slice must not add a second database or write screenshots into graph memory.

## Privacy boundary: opt-in desktop selector masking

`desktop.visual.mask_selectors` is optional and does not affect browser captures or behavior. It accepts one DOM-stable compound CSS selector only: optional tag or `*`, followed by `#id`, `.class`, `[attribute]`, or `[attribute=value]` clauses. Pseudo-classes/elements, combinators, selector lists, escapes, comments, and other CSS are rejected. When configured, masking is limited to matching visible regions in the top-level WebView document for WebView and process-owned X11 window screenshots; unsupported selector/overlay state and cleanup failures fail closed. This is not general PII redaction. Native chrome/dialogs, iframes and shadow roots outside the top-level document query, UI-tree/accessibility/text/MCP textual responses, and existing screenshots/artifacts are excluded.

### Phase 6 verification status

Oracle Gate 6A passed for lifecycle safety. The original center-only pixel checks were insufficient, so the canary was strengthened to calibrate from a unique connected green control component, validate plausible X/Y scale, verify every pixel in inset target/control interiors (opaque `[0,0,0,255]` for the target), and aggregate cleanup failures without hiding the primary test error. Oracle Gate 6B passed this controlled-pixel acceptance: a real Linux Tauri/WebKitGTK run captured WebView and process-owned X11 through the production `serve()` MCP route; persisted PNGs passed interior pixel checks, and MCP image blocks were byte-identical to the referenced artifacts with matching SHA-256 and byte length. This proves only the controlled inset interiors and capture paths, not arbitrary screen content. The dedicated `test:desktop-mask-pixels-native` requires a reachable X11 display, `tauri-driver`, `WebKitWebDriver`, `wmctrl`, and ImageMagick; it does not run as part of ordinary `npm test`. No general PII-redaction claim is made; the exclusions above remain.

## Historical desktop-visual delivery plan (foundation now implemented)

### Historical Phase 1 — Native Tauri control (foundation delivered)

1. Add strict optional desktop configuration for the target project, approved build command, Tauri binary, driver executable, readiness timeout, window identity, and capture mode.
2. Add read-only Tauri/Angular discovery and a capability report, including missing Linux driver/setup diagnostics.
3. Add `DesktopAutomationAdapter` and a Tauri WebDriver implementation that owns only the driver/app session it starts. Do not claim arbitrary-process attachment.
4. Add session start/status/stop/restart and bounded selector-based interactions, DOM snapshot, element geometry/style inspection, and useful capability errors.
5. Expose desktop operations in MCP without altering browser tool names or signatures.

**Exit evidence:** unit tests cover project discovery, configuration safety, selector/error behavior, and ownership cleanup; an opt-in local fixture demonstrates an actual Tauri binary and WebDriver. A browser renderer preview is not accepted as native validation.

### Historical Phase 2 — Real screenshots and MCP images (foundation delivered)

1. Detect X11/Wayland and report available capture backends.
2. Capture only a window positively associated with the managed session. X11 window-targeted capture is eligible; Wayland must use an explicitly supported/consented portal path or fail with an actionable permission/capability error. Never fall back to a whole-desktop image.
3. Keep WebDriver/WebView screenshots separately labeled and opt-in; never silently substitute them for `kind: window`.
4. Persist bounded PNG artifacts under the existing private artifact policy and return `type: image`, `mimeType: image/png` MCP content plus concise metadata and an artifact reference.

**Exit evidence:** an MCP stdio test checks the decoded PNG image block and metadata; display-specific integration checks run only when a real matching display and driver are available. A vision-capable runtime check remains environment-dependent.

### Historical Phase 3 — Visual improvement and verification loop (foundation delivered)

1. Return bounded UI tree and targeted styles/geometry alongside screenshot metadata.
2. Assemble a review bundle for the agent; do not fabricate model findings or infer visual quality from a pixel-difference score.
3. Add explicit caller-attested baseline saves, immutable revisions with compare-and-swap replacement, and before/after/diff artifacts linked to finding IDs.
4. Document a deterministic workflow for capture → agent edits using its existing tools → relaunch → same state → compare/review.
5. Exercise the loop on an intentionally clipped Tauri fixture when the required build toolchain and display are available.

**Exit evidence:** geometry detects deterministic overflow where supported; MCP tests cover baseline/finding lifecycle behavior, evidence integrity, and all-or-none image bundles. A real vision-model defect/fix review is not claimed from text-only tests.

### Historical Phase 4 — P1 hardening and extension (implemented items recorded below)

The opt-in selector privacy control and documented X11/Wayland/Windows compatibility boundaries are implemented; Wayland window capture and Windows remain unsupported. Existing memory reuse is delivered through the normal `memory_save` path, with no desktop-specific memory tool or schema. Visual profiles support bounded `window_size: {width, height}` for capture only, restoring the complete prior window rect afterward; other fields including `theme` remain persisted metadata and do not mutate app state. The explicit `desktop_assert` failure-screenshot path and reference-aware age retention are implemented. Keep Jira and the memory architecture unchanged.

**Retention safety gate:** age pruning is explicit opt-in and disabled by default. Before unlinking, enumerate every desktop artifact ref for the project across all environments and all immutable baseline revisions, comparisons, and findings. Prune only old, canonical managed regular PNGs that are absent from that complete set; fail closed if reference enumeration or path validation fails. Coordinate reference enumeration/unlink with artifact creation and every record-link writer using the shared serve-wide desktop operation queue; the existing project/DB lock excludes other UMB processes, while the queue handles concurrent MCP tool calls across sessions. An age grace period or SQLite transaction alone does not close the verify-then-link race. Test cross-environment/history protection, pruning eligibility and opt-out, enumeration failure, and writer/pruner races.

**Failure screenshots:** `desktop.visual.capture_on_failure` defaults to `false`. The explicit `desktop_assert` tool supports bounded semantic `present`, `visible`, `hidden`, `enabled`, and exact/contains text assertions. Only a completed FAIL can trigger an opt-in WebView screenshot; PASS, disabled capture, invalid inputs, and assertion errors do not capture. Capture failures preserve the assertion FAIL with a bounded status code. This diagnostic creates no finding or memory assertion and uses the normal private artifact and MCP image-delivery policies. General content is not automatically redacted; only explicitly configured desktop selector masks affect supported screenshot pixels, and those masks are not general PII redaction.

**Opt-in native fixture:** `npm run test:desktop-native` builds `tests/fixtures/tauri-app` and exercises the existing `DesktopService` direct `tauri-driver` path against a real Tauri WebView. The ordinary `npm test` skips this environment-dependent acceptance. Install Rust/Cargo and WebKitWebDriver, then install the driver with `cargo install tauri-driver --locked`. The fixture's Tauri Rust dependencies are declared in its Cargo package/lockfile; the native executables are platform prerequisites rather than npm dependencies. When a reachable X11 display, `wmctrl`, and ImageMagick `import` are available, the test also attempts `kind: window`; otherwise it reports that only the WebView capture was tested. Wayland window capture remains unsupported, and a real app test does not establish vision-model inspection.

## Forward parity roadmap (not yet implemented)

The phases below supersede the old assumption that desktop visual tools alone close the Tauri testing gap. The earlier delivery phases remain historical evidence for the desktop-visual foundation, not claims that workflow parity is complete.

### Phase 0 — Workflow failure screenshot evidence (complete)

Commit `77d72eb` added explicit `on_failure.capture: [desktop_screenshot]` support. Both `desktop.enabled` and `desktop.visual.capture_on_failure` are required; capture uses only an already-existing per-MCP-session service and never starts a desktop session. It reuses masked `DesktopService.capture('webview')`; configured masks remain narrow DOM overlays, not general PII redaction. Auth safe flows continue to suppress capture. Browser screenshots remain browser-backed and browser-first in ordinary workflow evidence; desktop screenshot artifacts have separate evidence/retention protection. This is diagnostic evidence only, not Tauri workflow execution.

**Acceptance evidence:** schema accepts/rejects the explicit mode; config and service-existence gates prevent incidental capture/start; mask-aware service path is used; auth capture remains suppressed; browser output is unchanged; best-effort statuses, atomic evidence links, cleanup, and retention refs are covered by focused tests.

### Phase 1 — Documented gap matrix (current)

Maintain the PRD and this plan's capability matrices with FULL/PARTIAL/UNSUPPORTED/NOT_APPLICABLE status, actual observable semantics, and acceptance criteria. Keep Playwright/browser APIs distinct from the native Tauri surface. Record WebKitGTK build variation, Wayland window capture and Windows native capture as limitations, not implied future guarantees.

**Acceptance gate:** reviewers can identify the current implementation, the planned subset, and unsupported behaviors without reading tool names as claims of parity. No source/schema changes belong to this documentation phase.

### Phase 2 — Tauri workflow adapter contract and design gate (not started)

Design an explicitly selected Tauri workflow adapter without changing the existing browser runner or silently falling back between backends. Specify preflight semantics, target forms, step outcomes, bounded errors, evidence/artifact handling, session ownership, and how unsupported steps are rejected before any side effect. Keep exact schema and tool names open until the design is reviewed. Run an Oracle gate on the contract and safety boundaries before implementation.

The design gate must explicitly decide: (a) per-action Tauri authorization/approval. Existing desktop actions do not use browser `authorize`, so define a secure fail-closed rule and a denial/no-side-effect test; (b) workflow `press` semantics. Workflow `press` targets an element while current desktop keypress is global; approve a validated focus-bound equivalent or exclude `press` and preflight-reject it; and (c) route-based `start_screen`, `end_screen`, `navigate`, and URL assertion semantics. Define reviewed Tauri equivalents or reject them before any step side effects.

Initial portable candidate subset: CSS targets; `click`, `type`, `scroll`, and possibly `press` only after the focus-bound semantic is approved; waits for `present`, `visible`, `hidden`, `enabled`; assertions for those states and text exact/contains. Reuse bounded preconditions, retries, and reporting only where the current contract has equivalent meaning. Browser-only navigation, route contracts, `fill`/`select`, URL/count/value conditions, role/label/placeholder/test-id locators, browser snapshot refs, upload, and browser diagnostics must fail Tauri preflight explicitly unless a specific native equivalent passes the design gate. No Playwright fallback.

**Acceptance gate:** approved adapter contract lists every accepted step and rejects every unsupported step before side effects; backend selection is explicit; no auto-start is introduced; browser tool signatures and behavior remain untouched. Tests prove action-approval denial has no side effect and unsupported `press` and route-based preconditions/postconditions/navigation/URL assertions fail preflight before any workflow step effects.

### Phase 3 — Bounded YAML Tauri workflow execution (not started)

Implement the approved adapter for the Phase 2 subset against an already-owned managed Tauri session. Reuse deterministic workflow records and report structure where compatible, but keep browser and desktop execution adapters separate. Preserve action approval boundaries, sensitive-variable handling, retries/timeouts, artifact safety/retention, masked WebView capture, and auth-flow capture suppression. Do not start a session merely to run or capture workflow failure evidence.

**Acceptance gate:** cross-backend contract tests show the same result shape for supported equivalent operations; Tauri fixture tests exercise every supported action/wait/assertion and verify text readback; approval-denial tests prove no action occurs; unsupported `press` and route-based workflow requirements fail preflight before effects; negative tests prove other unsupported browser-only steps never reach the browser runner. Run against available WebKitGTK builds and record runtime-specific failures rather than generalizing one build. The browser workflow suite must remain unchanged and pass.

### Later gaps — prioritize only after workflow gate

Investigate additional locator forms, desktop upload, desktop diagnostics, and direct navigation/history controls only where a meaningful, secure native semantic exists. Upload is a known isolated gap but is intentionally lower priority than the approved YAML workflow parity work. Do not equate a native window with browser tabs or claim a desktop console/network equivalent without observable support and tests.

**Acceptance gate:** each later feature gets an explicit capability contract, safe failure behavior, and backend-specific fixture coverage before being marked PARTIAL/FULL. Keep mobile, other desktop frameworks, arbitrary process attachment, and complete Playwright API parity out of scope.

## Verification budget

| Claim | Evidence owner | Minimum evidence | Limitation |
|---|---|---|---|
| Existing browser and memory behavior stays compatible | Repository test suite | `npm test`, `npm run typecheck`, `npm run lint` | Does not establish desktop runtime support |
| Desktop config/discovery is safe and backwards compatible | Config/service tests | Defaults load unchanged; invalid/unknown desktop keys reject; inspect never invokes commands | Tests do not prove a real build command is safe beyond explicit configuration |
| MCP returns an actual image content block | MCP integration tests | Official SDK client calls screenshot and decodes a PNG signature from `content[].data`; metadata labels `window` vs `webview` | Does not prove a vision model consumed the image |
| OS screenshot is the target window | Linux display integration | Match session-owned process/window identity and inspect PNG dimensions/content | Requires real X11 or supported portal/compositor; Wayland must fail safely when unsupported |
| Tauri WebDriver interactions work | Opt-in Tauri fixture | Launch configured test binary and execute navigation/selector/action/readback | Passes on Fedora 44/WebKitGTK 2.54.1 in the disposable container; host WebKitGTK 2.52.5 returns `unsupported operation` for click and W3C pointer Actions, so do not generalize across runtime builds |
| Visual fix was verified | Agent + fixture workflow | Same state captured before/after, explicit finding-linked review, no automatic “improved” claim | Subjective style quality requires an image-capable agent or human |

## Scope and reporting rule

P0 work is delivered in sequence and is not declared complete merely because MCP tools, WebView screenshots, or DOM data exist. Unavailable platform APIs, runtime-specific interaction failures, and untested vision-runtime delivery must remain explicit limitations in docs and the final implementation report. P1 items remain separately tracked.

## Current implementation status (2026-10-22)

**Implemented in this branch:** optional strict desktop config; read-only project/capability inspection; explicit argv-only build execution with timeout/stop signaling limited to the directly spawned build child; managed local `tauri-driver` sessions; basic selectors, interaction, semantic snapshots, computed-style/geometry/overflow inspection; X11 window-targeted capture guarded by exact title and managed process ancestry; separate WebDriver WebView capture; private bounded screenshot artifacts; MCP `image/png` content plus text metadata; and `desktop_review_ui` evidence collection that deliberately returns no model-generated findings. Desktop MCP sessions clean up only their owned driver/session tree. A configured build command may spawn descendants that are not guaranteed to stop when its direct child is signaled; UMB does not signal arbitrary PIDs.

**Evidence currently available:** the real Tauri fixture starts through the direct `tauri-driver` adapter; session startup, semantic tree, initial text readback, WebView PNG capture, and persisted artifact SHA-256 readback succeed. A process-owned X11/Xwayland window PNG was captured at 800×600 and compared pixel-identical to the WebView image. `wmctrl` was temporarily extracted from a Fedora 44 RPM into `/tmp/opencode` after signature verification. On the host's WebKitGTK 2.52.5, element click and W3C pointer Actions both returned HTTP 500 `unsupported operation`; the same opt-in `npm run test:desktop-native` passed in a disposable Fedora 44 container with WebKitGTK 2.54.1, including a real click and counter readback. That container skipped window capture because `wmctrl` and ImageMagick were absent; the host's X11 capture evidence is separate. This is consistent with [WebKit Bugzilla #318171](https://bugs.webkit.org/show_bug.cgi?id=318171), but does not prove local causal attribution. A same-state 800×600/counter-0 before/after visual check was also run through actual MCP baseline/compare tools: a temporary white-on-white button defect was captured, reverted by relaunch, and compared; an image-capable assistant inspected the actual three PNG blocks, and the linked finding was resolved in a temporary acceptance database. This validates the visual-evidence workflow, not a shipped product fix. Fake-adapter tests additionally cover config, driver protocol, ownership, quotas and display failures, including a dedicated non-Tauri `DesktopAdapters` contract test.

**Profile runtime check:** the real WebDriver window rect changed from 800×600 to 900×700 during a WebView capture; the screenshot was 900×700, and the original `{x,y,width,height}` rect was restored exactly. Fake-adapter MCP coverage also verifies profile sizing, invalid-dimension rejection before capture, restoration on callback failure, and artifact cleanup when restoration fails.

**Implemented in this branch:** the six MCP tools `desktop_baseline_save`, `desktop_baseline_read`, `desktop_compare_screenshots`, `desktop_finding_report`, `desktop_finding_list`, and `desktop_finding_update` provide a managed-artifact visual evidence loop. `desktop_baseline_save` takes `{baseline_key, kind?, profile?, approval_attestation: "approved", replace?, expected_revision?}` and captures the image internally; its response includes Store artifact ref/hash/byte fields. Baseline revisions are immutable; replacement requires `replace: true` and the expected current revision (compare-and-swap). Both the literal attestation and an affirmative configured `options.approver` callback are required. Profiles may specify bounded `window_size: {width, height}` (1–10000 integer dimensions), applied only during capture with full original window-rect restoration; all other fields, including `theme`, are persisted metadata only. `desktop_compare_screenshots` takes `{baseline_key, kind?, profile?, threshold?, finding_ids?}` and returns `{comparison, baseline_ref, after_ref, diff_ref, metrics}`. Evidence refs are canonical project-root-relative refs and persisted evidence is verified through `DesktopService.readArtifact`; comparisons persist refs, hashes, byte counts, metrics, and optional linked finding IDs. Resolution requires both an explicit assessment and a comparison linked to the finding, with expected-version state transitions. Comparison MCP image delivery is opt-in and all-or-none: baseline, after, and diff images are emitted together only when aggregate raw bytes are at most 6 MiB; otherwise the response explicitly reports artifact-only and still returns refs/metrics.

**Approval and observation boundary:** `approval_attestation` is caller-supplied intent, not proof of human authorization or image inspection. The configured approver callback must affirmatively confirm the save and is a separate server-side gate, but cannot establish that a human or model actually inspected the image. The server cannot know whether an MCP client displayed/consumed image blocks. Pixel metrics describe change and never imply visual quality. Existing browser tool behavior/signatures remain unchanged.

**Desktop learning reuse:** this is an explicit two-step caller workflow, not automatic finding writeback. First use the desktop evidence tools and have the caller actually review the images; after choosing to author reusable learning, make a separate `memory_save({content, title?})` call with a bounded caller-authored summary, optionally mentioning finding/comparison IDs. Finding report/update, a resolved status/assessment, baseline approval, and comparison metrics do not prove human approval or image review and must not trigger writes. `memory_save` remains governed by the existing per-project `memory.persistent_learning_writes` opt-in, LearningWriter redaction and NLP readiness, and current project/environment scope. The result is an `agent_learned` note rather than a `verified_fact`; no structured graph relationship is created, and any IDs appear only in note text. Do not persist screenshot bytes or raw screen content, or infer quality from pixel metrics. The focused stdio MCP test exercises baseline, finding, comparison, resolution, then the separate explicit save and normal search/get retrieval, including configured-secret redaction. Default desktop fixture mode continues to leave persistent writes disabled.

**Still unverified or not implemented:** there is no YAML workflow execution adapter for Tauri; `test_run_workflow` still uses the browser runner and `desktop_screenshot` is failure evidence only. Interaction acceptance passes on Fedora 44/WebKitGTK 2.54.1 in a disposable container, while this host's 2.52.5 runtime still rejects click and W3C pointer Actions; do not generalize the passing runtime to other distro/build variants. The visual before/after path passed with a temporary injected contrast defect and an inspected same-state MCP comparison, but there is no persistent defect/fix fixture or shipped application fix acceptance. Linux Wayland portal capture and Windows native window capture are unsupported. The release packaging regression test now inspects the generated bundle and rejects the Tauri acceptance fixture or compiled `tauri-acceptance-fixture` binary. There is no automatic desktop memory bridge; reusable learning requires the separate caller-authored `memory_save` step above. Workflow failure capture now supports explicit `on_failure.capture: [desktop_screenshot]`; it is opt-in and best-effort, requires both `desktop.enabled` and `desktop.visual.capture_on_failure`, and only uses an already-created per-MCP-session desktop service (it never starts a service/session). Its artifact ref is separate from the browser `screenshot` ref and the existing masked WebView `DesktopService.capture('webview')` path is used. Auth-flow safe outcomes continue to disable all failure capture. Age retention is opt-in through `desktop.visual.retain_artifacts_max_age_days` (absent means disabled); pruning enumerates project-wide refs across environments and history and shares the serve-wide desktop operation queue with artifact/link writers. `desktop_assert` failure screenshots are opt-in through `desktop.visual.capture_on_failure`; they are diagnostic WebView artifacts, not persisted findings or memory assertions. Remaining platform limitations and the lack of an automatic desktop memory bridge remain tracked; they are not completed P0 claims.
