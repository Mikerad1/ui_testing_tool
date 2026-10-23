# UI Memory Browser (UMB)

UMB is a local TypeScript CLI and MCP server for testing a web application through a Playwright-controlled browser. The CLI loads a project configuration and YAML knowledge into a project-scoped SQLite graph, then serves browser, assertion, and memory tools to an MCP client. Persistent-learning writes are disabled by default; a project can explicitly opt in with `memory.persistent_learning_writes: true`. For an opted-in project, the normal LearningWriter path handles direct `memory_save` writes and YAML reconciliation through redaction and a healthy spaCy boundary, including applicable serve/startup/reload/watch flows. Saved learnings are persistent project memory and immediately reusable through normal retrieval. Bulk backfill remains independently disabled/operator-gated. An installed agent skill gives Codex or Copilot instructions for using those tools; it does not configure MCP connections. Jira is optional and separately configured by you.

**Mental model:** your app runs separately; UMB owns the browser and project memory; your MCP client connects an agent to UMB (and, if needed, to a separate Jira MCP). YAML supplies initial app knowledge. Persistent learning is a per-project opt-in, off by default; set `memory.persistent_learning_writes: true` to activate the normal LearningWriter path for `memory_save` and YAML reconciliation, including applicable serve/startup/reload/watch flows. `memory_save({content, title?})` writes directly to this project and environment; a successful response means the note is persistent and immediately reusable through normal retrieval. No assertion refs, approval, or follow-up action are required. Writes pass through redaction and require healthy spaCy readiness. Bulk backfill remains separately disabled/operator-gated and is not enabled by this setting. Browser run/assertion/evidence records are distinct operational records.

## Prerequisites and install

- A web application and a compatible MCP client.
- For a release bundle: Windows x64 or Linux x64; download and extract [`umb-windows-x64.zip` or `umb-linux-x64.tar.gz`](https://github.com/Mikerad1/ui_testing_tool/releases/latest). Bundles include Node.js and production dependencies, not Playwright browser binaries.
- For source: Node.js 20+ and a checkout; use the commands below. The source-install path also uses the repository's pinned Playwright package.

The targeted locally packaged v0.2.7 Linux x64 smoke exercised the bundle launcher/PATH/browser-install sequence successfully. This is limited Linux x64 evidence; it does not establish Windows or all-Linux compatibility, nor OS dependency installation.

Install Chromium separately. For a bundle run its bundled Playwright CLI from the extracted directory:

```sh
./payload/runtime/bin/node ./payload/node_modules/playwright/cli.js install chromium
```

PowerShell equivalent:

```powershell
.\payload\runtime\node.exe .\payload\node_modules\playwright\cli.js install chromium
```

Linux may require Playwright system libraries. See [release bundle details](#release-and-platform-notes).

Source install:

```sh
npm ci
npx playwright install chromium
npm run build
npm link
```

Do not run source build commands inside a release bundle.

## No-Jira browser quick start

This uses a running app available at `http://127.0.0.1:3000` and an MCP client that can connect to Streamable HTTP MCP with a Bearer token. UMB does not ship a demo web app or a universal MCP-client configuration file, so provide your own app and use your client's documented server-connection UI/configuration.

1. Work from a dedicated project directory that will hold `umb.config.yaml`, `umb-knowledge/`, and `.umb/` data—not the UMB source checkout or extracted bundle installation. Make the `umb` launcher available on `PATH` (`npm link` from the source checkout, or add the extracted bundle directory to `PATH`), then initialize the project:

   ```sh
   umb init --project demo --url http://127.0.0.1:3000 --starter-knowledge
   ```

   This creates `umb.config.yaml` and two seed documents in `umb-knowledge/`: an application (`demo`, start screen `home`) and an empty Home screen. Keep the project ID/base URL aligned with your app; edit the seed YAML to describe real screens/elements as needed. Check the complete tree:

   ```sh
   umb knowledge validate --config ./umb.config.yaml
   umb doctor --config ./umb.config.yaml
   ```

2. Set a long random token in the environment, then start UMB:

   ```sh
   export UMB_MCP_TOKEN='<long-random-secret>'
   umb serve --config ./umb.config.yaml
   ```

   PowerShell equivalent: `$env:UMB_MCP_TOKEN = '<long-random-secret>'`. Keep the terminal running. Configure your MCP client separately to connect to `http://127.0.0.1:7317/mcp` with `Authorization: Bearer <token>`; never commit or share the token.

3. In the connected MCP client, call `browser_status`; when the app is ready, call `browser_navigate` with `http://127.0.0.1:3000/`, then `browser_snapshot`. A minimal successful check is `test_assert` with `{ "condition": "url_matches", "expected": "127.0.0.1:3000" }`. Expected: status `PASS`, with a recorded run/evidence reference. `browser_status` reports `application_ready: false` if the app was unavailable at startup; start the app and call `browser_refresh` before browser-dependent tools. The assertion checks the current browser URL, not your app's business behavior; add a meaningful visible/text assertion after authoring matching YAML locators.

This is a browser/MCP test only. It does not contact Jira. `umb doctor` checks configuration, YAML, auth/port, existing database integrity/schema, and headless browser launch; it does not navigate to or test the app.

**Evidence boundary:** the repository's local integration harness exercises `browser_status`, `browser_navigate`, `browser_snapshot`, and `test_assert` against a loopback fixture app and temporary project/database/artifacts, including a `url_matches` PASS with run/evidence references. This is harness coverage, not arbitrary-client onboarding. The documented user path remains unexercised: launching the user's own app; running `umb init`, validation/doctor, then `umb serve` from a dedicated project; configuring and authenticating a real external MCP client; and observing those calls and PASS/run evidence in that client. OS-specific/source-checkout installation instructions have not been exercised as part of this quick-start fixture. The harness does not prove the full documented installation-to-serve sequence.

## Desktop testing (Linux/Tauri, experimental)

Desktop support is an opt-in extension; it does not replace Playwright browser testing. The P0 native path uses a prebuilt Tauri binary and the native `tauri-driver` WebDriver. UMB does not attach to arbitrary existing apps. `desktop_project_inspect` is read-only; it never executes a project command. `desktop_session_start` runs only the optional command explicitly listed in `desktop.build_command` (as an argv vector with no shell), then asks `tauri-driver` to launch the configured binary. If no build command is configured, build the test/debug binary yourself first. Release/production instrumentation is not added to the Tauri app.

For Linux native automation, install a compatible Tauri 2 `tauri-driver` and WebKitGTK WebDriver (`webkit2gtk-driver` where your distribution requires it). The default driver path must be provided as an absolute executable path. For real OS-window screenshots on **X11**, also install `wmctrl` and ImageMagick's `import`; the window title must match exactly and its PID must descend from UMB's managed driver process. Linux Wayland currently has no consented portal integration: `kind: window` returns an explicit unsupported/permission error and never captures the whole desktop. `kind: webview` is a distinct WebDriver screenshot and is not a substitute for `kind: window`.

Add an explicit desktop section to the existing `umb.config.yaml` (all paths are relative to the desktop project root unless absolute paths are required):

```yaml
desktop:
  enabled: true
  framework: tauri
  root: .
  automation:
    provider: tauri-driver
    driver_path: /usr/bin/tauri-driver
    binary_path: src-tauri/target/debug/my_app
    ready_timeout_seconds: 120
  window:
    title: My Desktop App        # exact X11 title required for kind: window
    screenshot_mode: window
  visual:
    output_directory: ./.umb/artifacts
    return_mcp_images: true
    capture_on_failure: false # desktop_assert FAIL only; WebView PNG, opt in explicitly
```

If you add `build_command`, its command and arguments are spawned without a shell and run only on an explicit session-start call. Choose a command that creates the binary at `binary_path`; UMB does not guess application-specific build outputs. Inspection/capability calls do not execute that command. A build timeout or stop signals only the directly spawned command; if it launches descendants, they may continue running. Configure commands that handle or contain their own descendants. UMB does not signal arbitrary process IDs. Store screenshots under the configured project artifact root's private `.umb-managed/desktop/` directory.

### Opt-in desktop visual masking (experimental)

Masking remains off unless `desktop.visual.mask_selectors` is explicitly configured; it does not change the browser contract. Each selector must be a single DOM-stable compound selector: an optional tag name or `*`, followed only by `#id`, `.class`, `[attribute]`, or `[attribute=value]` clauses. Pseudo-classes/elements, combinators, selector lists, escapes, comments, and other CSS are rejected. A capture fails closed when selector matching, overlay integrity, or cleanup cannot be verified. The intended scope is only configured matching regions in the top-level WebView DOM, for WebView and process-owned X11 window screenshots. This is not general PII redaction: native chrome/dialogs, iframes or shadow roots outside the top-level document query, UI-tree/accessibility/text/MCP textual outputs, and previously saved screenshots/artifacts are outside the mask. Oracle Gate 6A passed for lifecycle safety. After Oracle Gate 6B identified center-only checks as insufficient, the native canary was strengthened to calibrate from the connected green control and verify every pixel in inset target/control interiors (including opaque-black alpha); the real WebView/X11 rerun and exact MCP artifact-byte checks pass. Oracle Gate 6B passed this controlled-pixel acceptance. The evidence covers only the tested inset interiors and capture paths; review screenshots for sensitive content before sharing.

After starting UMB and connecting an MCP client, use `desktop_capabilities`, `desktop_project_inspect`, `desktop_session_start`, `desktop_get_ui_tree`, `desktop_find_element`, the `desktop_click`/`desktop_type`/`desktop_keypress`/`desktop_scroll` interaction tools, and `desktop_get_element_details`. `desktop_assert` supports bounded `present`, `visible`, `hidden`, `enabled`, and exact/contains `text` checks; it returns PASS/FAIL without echoing expected/actual text. Only an assertion FAIL can trigger a screenshot, and only when `desktop.visual.capture_on_failure: true` is explicitly configured; that diagnostic captures a WebView PNG only, and does not create a finding or memory assertion. PASS, disabled capture, invalid input, or assertion errors do not capture. The image is subject to the normal artifact policy and may contain unredacted screen content. Call `desktop_screenshot` with `{ "kind": "window" }` for the OS-targeted image or `{ "kind": "webview" }` for WebDriver content. `desktop_review_ui` collects a screenshot and bounded structure/design context for the agent; it returns no visual findings because UMB does not run a visual model. Screenshots return an MCP `image/png` content block plus capture/session metadata and an artifact reference when image delivery is enabled and within the payload limit. Clients that do not consume image blocks are not detectable by the MCP server; use the artifact and structural data, and do not claim a visual assessment unless an image-capable agent actually saw the image. Setting `return_mcp_images: false` or exceeding the payload cap returns an explicit artifact-only status.

Direct desktop tools accept CSS strings or structured `{by: 'role', role, name?}`, `{by: 'test_id', value}`, and `{by: 'placeholder', value}` targets. Role/name matching is exact and case-sensitive using an explicit role or a small HTML-tag fallback and a trimmed `aria-label`, else `innerText`, else `alt` name approximation, capped at 300 characters. This is not full ARIA accessible-name computation. `test_id` compares the `data-testid` attribute exactly. Placeholder matching compares the raw `placeholder` attribute by exact, case-sensitive equality, with no whitespace normalization, and is limited to `textarea` plus `input` types `text`, `search`, `url`, `tel`, `email`, and `password`; its value must contain 1–1000 characters. Semantic mutation actions require one visible, enabled match. This is a bounded DOM locator, not full Playwright parity. Label and text locators remain unsupported. Tauri YAML workflows remain CSS-only; `browser_*` and `test_run_workflow` remain Playwright-backed.

`desktop_upload` is an experimental direct MCP tool, not a Tauri YAML workflow action. It uploads one project-relative regular file (maximum 20 MiB) under the configured desktop root to a unique enabled `input[type=file]` in the already-running managed session. It uses W3C Element Send Keys; it does not open a native chooser or set files through JavaScript. Traversal, symlink escapes, and CR/LF paths are rejected; results return the basename and byte length, not the absolute path. If `security.high_risk` contains any `upload` or `any` rule, all desktop uploads fail closed because no desktop approval prompt is available. Native upload and semantic-locator acceptance passed on Fedora 44 WebKitGTK/WebKitWebDriver 2.54.1-1.fc44; other runtimes are unverified.

### Baselines, comparisons, and findings (experimental)

The desktop visual lifecycle is an explicit opt-in alongside desktop support. The six tools are `desktop_baseline_save`, `desktop_baseline_read`, `desktop_compare_screenshots`, `desktop_finding_report`, `desktop_finding_list`, and `desktop_finding_update`. Use managed desktop screenshot artifacts as evidence; each persisted evidence reference must be a canonical project-root-relative artifact ref and its recorded SHA-256/byte length is checked against the artifact read by DesktopService. Arbitrary paths or mismatched hashes are rejected.

Typical calls (fields shown are the public MCP argument names):

```json
{"tool":"desktop_baseline_save","arguments":{"baseline_key":"settings-default","kind":"window","profile":{"screen":"settings","theme":"light"},"approval_attestation":"approved"}}
{"tool":"desktop_baseline_read","arguments":{"baseline_key":"settings-default"}}
{"tool":"desktop_compare_screenshots","arguments":{"baseline_key":"settings-default","kind":"window","profile":{"screen":"settings","theme":"light"},"threshold":0,"finding_ids":[]}}
{"tool":"desktop_finding_report","arguments":{"screen":"settings","severity":"medium","confidence":0.9,"category":"layout","observed_issue":"The save control overlaps its label.","region":{"x":20,"y":30,"width":100,"height":40},"screenshot_ref":".umb/artifacts/.umb-managed/desktop/window-1.png","screenshot_sha256":"<64-hex-digest>","screenshot_bytes":12345}}
{"tool":"desktop_finding_update","arguments":{"id":"<finding-id>","expected_version":1,"status":"resolved","assessment":"The linked comparison shows the overlap is gone.","comparison_id":"<linked-comparison-id>"}}
```

`desktop_baseline_save` accepts `{baseline_key, kind?, profile?, approval_attestation: "approved", replace?, expected_revision?}` and captures the current desktop image internally. Its result includes the Store baseline row fields, including `artifact_ref`, `artifact_sha256`, and `artifact_bytes`; callers do not supply capture bytes or evidence metadata. Use those returned fields as finding evidence. A profile may include `window_size: {width, height}` (integer dimensions from 1 through 10000); this size is applied only for capture and the original window position and size are restored afterward. Other profile values, including `theme`, are persisted metadata only—UMB does not change app state or theme. Comparison requires the same profile metadata, including `window_size`. Replacement requires `replace: true` and `expected_revision` together; an initial save omits both. Baseline revisions are immutable. Replacement uses compare-and-swap against the current revision and fails rather than overwriting a concurrent/newer revision. Saving requires both the literal caller attestation and a configured `options.approver` callback that affirmatively confirms the request; a missing or negative callback must refuse the save. The attestation is **caller-supplied intent, not proof of human approval**; neither the attestation nor callback proves that a model/human actually inspected the image. Configure image-capable tooling and obtain the actual review before supplying the attestation; UMB does not infer visual approval.

`desktop_compare_screenshots` accepts `{baseline_key, kind?, profile?, threshold?, finding_ids?}`. It captures the after image internally using the profile's temporary `window_size` when supplied (restoring the full original window rect afterward), and returns `{comparison, baseline_ref, after_ref, diff_ref, metrics}`; `comparison` is the persisted Store row (including `id` and linked `finding_ids`).

Comparisons persist baseline/after/diff evidence references, SHA-256 and byte lengths, pixel-change metrics, the profile/capture kind, and optional linked finding IDs. Metrics quantify pixel changes only and do not establish whether the interface improved. By default, a comparison returns its three PNG image blocks (baseline, after, and diff) together only if image delivery is enabled and their **aggregate raw byte size is at most 6 MiB**. If disabled, invalid, or over limit, it returns no image blocks and an explicit artifact-only fallback with refs and metrics; it never returns a partial bundle. Set `desktop.visual.return_mcp_images: false` to opt out. Finding reports require screenshot evidence. Finding resolution requires both a written `assessment` and a `comparison_id` linked to that finding; status updates use `expected_version` to reject stale writes. List tools support status/limit filtering.

Reusable desktop learning is a separate, explicit second step: only after the caller has actually reviewed the evidence and chosen to author learning, call the existing `memory_save({content, title?})` with a bounded, caller-authored summary (optionally mentioning finding/comparison IDs). Finding report/update, resolution, baseline approval, and pixel metrics never auto-write or establish human approval/image review. `memory_save` remains subject to the project's `memory.persistent_learning_writes: true` opt-in, LearningWriter redaction and healthy NLP readiness, and project/environment scope. This saves an `agent_learned` note, not a `verified_fact`; no graph relationship is created (IDs are only optional note text). Do not include screenshot bytes or raw screen content, and do not infer visual quality from pixel metrics.

This pipeline records caller-provided evidence and image payload delivery; it is not a vision model or human approval service. MCP image blocks only prove that bytes were delivered to the client. Whether a client or agent actually displayed/inspected them remains outside UMB's visibility. See the [implementation plan](docs/DESKTOP_TESTING_IMPLEMENTATION_PLAN.md) for limitations and evidence status.

**Runtime evidence (Linux, experimental):** the real Tauri fixture starts through the direct `tauri-driver` adapter; session, semantic tree, text, persisted WebView PNG, X11 window capture, and restorable size-profile behavior were exercised. On the host's WebKitGTK 2.52.5, element click and W3C pointer Actions both returned HTTP 500 `unsupported operation`. In a disposable Fedora 44 container with WebKitGTK 2.54.1 and its packaged `WebKitWebDriver`, `npm run test:desktop-native` passed, including a real button click and counter readback; window capture was skipped in that container because `wmctrl`/ImageMagick were absent. No host WebKit libraries were replaced. This confirms the interaction test passes on that runtime, but does not prove Bugzilla #318171 is the sole cause of the host failure. Separately, an actual stdio MCP visual loop captured a temporary white-on-white button defect and its repaired state at the same 800×600/counter-0 profile; an image-capable assistant inspected the baseline, after, and diff blocks, and the linked finding was resolved in a temporary acceptance database. The defect was injected at runtime and reverted by a fresh launch, not committed as an app-source fix; this verifies the evidence workflow, not product visual quality. A smoke `desktop_review_ui` inspection also found the counter fixture legible without obvious clipping. Wayland portal capture and Windows support remain unsupported. The existing opt-in `memory_save` path is documented and integration-tested as a separate caller-authored step; it does not establish human review or create structured graph links. See the [desktop implementation plan](docs/DESKTOP_TESTING_IMPLEMENTATION_PLAN.md).

## Configuration and agent skills

The default `umb.config.yaml` generated by `umb init` binds the server to loopback (`127.0.0.1:7317`) with token auth, allows the configured app origin, stores artifacts and SQLite memory under `.umb/`, reads YAML from `umb-knowledge/`, and leaves `memory.persistent_learning_writes` false. Change origins deliberately; navigation and redirect hops are restricted to the configured base URL and allowlist. `umb init` refuses to overwrite existing targets. See the [example config](examples/demo-project/umb.config.yaml) and [example knowledge tree](examples/demo-project/umb-knowledge/).

Install the portable UMB skill from the project root:

```sh
umb agent install --runtime codex --scope project
umb agent install --runtime codex --scope user
umb agent install --runtime copilot --scope project
umb agent install --runtime copilot --scope user
umb agent list
umb agent doctor --runtime codex
umb agent doctor --runtime copilot
```

Codex paths are `<project>/.agents/skills/umb-ui-testing/SKILL.md` and `~/.agents/skills/umb-ui-testing/SKILL.md`. Copilot CLI and VS Code Copilot share `<project>/.github/skills/umb-ui-testing/SKILL.md` and `~/.copilot/skills/umb-ui-testing/SKILL.md`. The installer only installs the skill; it does **not** register UMB MCP, configure Jira MCP, or edit any MCP settings. Set up those MCP servers separately in your client. `agent doctor` validates local installation/runtime diagnostics, not host recognition. In the implementation environment, Copilot CLI was absent and VS Code 1.133.0 was present without the Copilot extension; Copilot host recognition was not tested, and the minimum Copilot CLI version is undocumented.

## Memory, YAML seeds, and spaCy

YAML documents under the configured knowledge path define application, role, screen, workflow, and navigation knowledge. Copy or edit the examples in `examples/demo-project/umb-knowledge/`, then validate before starting UMB. YAML seeds are unverified by default; `memory.trust_yaml_seeds: true` is an explicit retrieval opt-in and does not change their verification status. A full-tree reload is available as `umb knowledge reload --config ./umb.config.yaml`; it reconciles graph state and can tombstone YAML-owned records removed from the tree, so preserve documents you still need. UMB validates YAML and references as a complete tree.

Persistent graph memory is available for context/search/read and reuse across UMB runs. Persistent-learning writes are disabled by default and opt in per project with `memory.persistent_learning_writes: true` (omitted means false). This activates the normal LearningWriter path for `memory_save({content, title?})` and YAML reconciliation, including applicable serve/startup/reload/watch flows, through redaction and a healthy spaCy boundary. This is not a global default. Use the single `memory_save` tool for agent learnings; a successful save is immediately persistent and available through normal retrieval in the current project/environment. It does not require assertion refs, approval, or a separate follow-up action. Never persist secrets or raw sensitive values. Operational run/assertion/evidence writes are separate. Bulk `umb memory backfill` remains separately disabled/operator-gated and cannot be enabled by this property. The demo starter rules are in [`examples/demo-project/memory-patterns-v1.json`](examples/demo-project/memory-patterns-v1.json), configured as `memory.patterns_file: ./memory-patterns-v1.json` relative to `umb.config.yaml` in [`examples/demo-project/umb.config.yaml`](examples/demo-project/umb.config.yaml). The sidecar adds project rules to packaged `python/patterns-v1.json`, which now covers all seven ontology labels and all five relation types. A valid empty custom rules file does not remove packaged rules. Invalid configured rules fail closed rather than silently falling back. When NLP health is healthy but effective rules do not support candidate extraction, normalized-only observations may be persisted through an explicitly enabled writer; unhealthy NLP readiness is rejected. Official release bundles include a pinned Python/spaCy runtime and model; there is no source-checkout provisioning command. `umb memory doctor --config ./umb.config.yaml --json` checks runtime/sidecar and existing database health without creating or migrating it; it does not establish actual extraction or packaged-runtime readiness. Packaged ontology coverage and bounded test evidence do not establish overall FR-07 acceptance; Windows/release-archive and other acceptance evidence remain open. `umb doctor` does not check NLP readiness.

## Optional Jira path — not authorized for writes

For Jira-backed work, supply an explicit issue key and configure your Jira MCP independently; use it to read that issue's description/custom fields and, when authorized, for normal Jira comments. UMB has no issue discovery, no general UMB Jira client, and does not configure or replace your Jira MCP. The skill requires the exact supplied key and forbids searching/selecting issues.

UMB's only narrow Jira write surfaces are the experimental CLI screenshot-comment publisher and `jira_publish_screenshot_table` MCP tool. They are not general comment/reporting clients: the MCP tool publishes a bounded table with a managed screenshot; use your separately configured Jira MCP for ordinary comments. These publishers can target production projects, but every write still requires fresh, exact task authorization for the issue, site, and operation.

#### Credentials and MCP-host setup

Create an Atlassian API token for the Jira account at [Atlassian API tokens](https://id.atlassian.com/manage-profile/security/api-tokens). That account must be able to browse the target issue and add comments and attachments. UMB reads `JIRA_EMAIL` and `JIRA_API_TOKEN` from the **UMB process environment** by default. Supply them to the UMB MCP server process using your MCP host's environment/secret mechanism, then restart that server. This applies to any MCP host; OpenCode is not required. If you launch the MCP host from a terminal, its child UMB server inherits that terminal's environment.

PowerShell (session-scoped; the token is masked while entered):

```powershell
$env:JIRA_EMAIL = Read-Host "Jira account email"
$secureToken = Read-Host "Atlassian API token" -AsSecureString
$tokenPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
try {
    $env:JIRA_API_TOKEN = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($tokenPointer)
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($tokenPointer)
}
# Launch/restart your MCP host from this shell, or inject these variables
# into the UMB MCP server through the host's secure environment mechanism.
```

Bash (session-scoped; the token is not echoed or placed in shell history):

```bash
read -r -p 'Jira account email: ' JIRA_EMAIL
export JIRA_EMAIL
read -r -s -p 'Atlassian API token: ' JIRA_API_TOKEN
printf '\n'
export JIRA_API_TOKEN
# Launch/restart your MCP host from this shell, or inject these variables
# into the UMB MCP server through the host's secure environment mechanism.
```

For a desktop MCP host, use its documented secure environment injection or a local wrapper; setting variables in a separate terminal does not change an already-running host. These variables are available in plaintext to the UMB process and its children, so do not store them in project files, commit them, or expose them in logs. Credentials only make API access possible; they do not authorize a write.

Both publishers default to dry-run. The CLI network path requires `--write` and `--experimental-inline-wiki`, an HTTPS Jira Cloud origin, `artifacts.redact_sensitive: true`, and an image inside the managed `.umb-managed` artifacts directory. The MCP tool requires both `write: true` and `experimental_inline_wiki: true`, plus a valid managed image and bounded table data. Every write additionally requires fresh, exact task authorization naming the issue, site, and operation. Inline wiki rendering remains experimental and must be checked in Jira. The previous one-call authorization is consumed; it grants no future writes. This README authorizes no write.

To locate existing results, use the explicitly supplied issue in your Jira MCP and inspect its comments; use the referenced Jira attachment to view the image. UMB's CLI prints the result of its local/dry-run operation, but does not provide a Jira browsing interface. Do not report an attachment as uploaded unless Jira confirms it.

## CLI essentials

Run `umb --help` or `umb <command> --help` for generated options. Config defaults to `umb.config.yaml`.

| Command | Purpose |
| --- | --- |
| `umb init [--project <id>] [--url <url>] [--yes] [--starter-knowledge]` | Create config and knowledge directory; starter docs are opt-in. |
| `umb knowledge validate [--json]` / `umb doctor [--json]` | Read-only YAML validation / local diagnostics. |
| `umb memory doctor [--config <path>] [--json]` | Read-only memory runtime and existing-database diagnostics; does not provision, create, or migrate. |
| `umb serve [--watch-knowledge] [--no-update-check]` | Start authenticated Streamable HTTP MCP. |
| `umb mcp --stdio` | Start local subprocess MCP; stdout is protocol only. |
| `umb agent install|list|doctor|uninstall` | Manage/check portable agent skills; no MCP configuration edits. |
| `umb knowledge reload` | Reconcile full YAML tree; takes project lock and mutates graph ownership state. |
| `umb memory backfill` | Separately disabled/operator-gated NLP memory maintenance; see above. |
| `umb jira comment <issue_key> --site <origin> --image <path>` | Experimental, dry-run-by-default screenshot publisher; no further writes authorized. |

Other implemented commands include `umb playwright endpoint`, locator proposals/confirmation, workflow verification/export, and bundle `umb update`. Locks prevent concurrent lock-taking commands for a project. Read `--help` before using commands that mutate state.

## Troubleshooting, security, and limitations

- **Browser does not start:** install the Playwright browser matching the packaged/locked Playwright version; Linux may need OS libraries. `umb doctor` diagnoses headless launch, but does not install dependencies.
- **App not ready:** start the configured app, then call `browser_refresh`; browser tools need a ready application.
- **MCP connection fails:** check loopback URL, running server, Bearer token, and client support for Streamable HTTP. Do not use unauthenticated MCP beyond explicitly trusted loopback development.
- **Knowledge validation fails:** check strict YAML schemas, unique IDs, references, and that config YAML is not placed in the knowledge tree.
- **Agent skill not recognized:** inspect installed path with `umb agent list`/`doctor`; static file validity does not prove Copilot host recognition.
- **Jira:** dry-run is default; do not retry an ambiguous network write blindly. No additional Jira writes are authorized here.

Keep credentials out of YAML, shell history, source control, and model-visible arguments; use environment variables/client secret storage. Screenshot artifacts are project-confined, managed under `.umb-managed`, and form fields are masked by default. Authenticated MCP is the default. Browser state is shared across MCP clients, not isolated per client. UMB does not discover Jira issues, transition status, or delete Jira data. Direct project-memory saves use the spaCy/redaction boundary and are disabled by default, with a per-project opt-in via `memory.persistent_learning_writes: true`. Bulk backfill remains separately disabled/operator-gated. Trace capture/artifact export are unimplemented; optional CDP attachment is deferred.

## Further reading

- [Demo config and YAML](examples/demo-project/umb.config.yaml) and [demo knowledge](examples/demo-project/umb-knowledge/)
- [CLI, config, MCP, and YAML operational reference](docs/CLI_CONFIG_MCP_REFERENCE.md)
- [UI Memory Browser product requirements](docs/UI_Memory_Browser_PRD.md)
- [Enhancement requirements and implementation status](docs/ui_testing_tool_enhancement_prd.md)
- [Jira UI testing implementation plan](docs/JIRA_UI_TESTING_IMPLEMENTATION_PLAN.md)
- [Release bundles and platform notes](#release-and-platform-notes)

The operational reference documents implemented interfaces; the PRDs provide requirements and broader product context.

## Release and platform notes

Official tagged releases provide Windows x64 and Linux x64 archives, not single-file executables. Extract and run the root `umb.cmd`/`umb` launcher. The browser binaries are separate; on Linux a supported Debian/Ubuntu system may install system dependencies with Playwright's `--with-deps` option. Keep project config/data outside the application bundle. Release bundles support `umb update`; see the [release page](https://github.com/Mikerad1/ui_testing_tool/releases/latest). The bundle's update behavior and browser package version are release-specific.

## License

MIT; see [LICENSE](./LICENSE).
