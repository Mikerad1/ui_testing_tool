# UI Memory Browser (UMB)

UMB is a local TypeScript CLI and MCP server for testing a web application through a Playwright-controlled browser. The CLI loads a project configuration and YAML knowledge into a project-scoped SQLite graph, then serves browser, assertion, and memory tools to an MCP client. The bounded persistent-learning proposal path is implemented through the spaCy/redaction/provenance boundary, but runtime writes are currently disabled pending final FR-07 integration and evidence gates. Proposals remain unverified; verification is separate, human-approved, and evidence-gated. Bulk backfill remains independently disabled/operator-gated. An installed agent skill gives Codex or Copilot instructions for using those tools; it does not configure MCP connections. Jira is optional and separately configured by you.

**Mental model:** your app runs separately; UMB owns the browser and project memory; your MCP client connects an agent to UMB (and, if needed, to a separate Jira MCP). YAML supplies initial app knowledge. The bounded `memory_propose`/`memory_add_edge` pipeline is implemented through the spaCy/redaction/provenance boundary, but persistent writes are currently disabled pending final FR-07 integration and evidence gates. If enabled after those gates, proposals remain unverified pending separate human-approved, evidence-gated verification; bulk backfill is independently disabled/operator-gated. Browser run/assertion/evidence records are distinct operational records.

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

## Configuration and agent skills

The default `umb.config.yaml` generated by `umb init` binds the server to loopback (`127.0.0.1:7317`) with token auth, allows the configured app origin, stores artifacts and SQLite memory under `.umb/`, and reads YAML from `umb-knowledge/`. Change origins deliberately; navigation and redirect hops are restricted to the configured base URL and allowlist. `umb init` refuses to overwrite existing targets. See the [example config](examples/demo-project/umb.config.yaml) and [example knowledge tree](examples/demo-project/umb-knowledge/).

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

Persistent graph memory is available for context/search/read and reuse across UMB runs. The bounded `memory_propose`/`memory_add_edge` pipeline is implemented through the spaCy/redaction/provenance boundary, but runtime persistent writes are currently disabled pending final FR-07 integration and evidence gates. Agent source limits are guidance, not MCP-enforced evidence (`memory_propose` has no verifiable evidence/source field). Never persist secrets or raw sensitive values. Proposals remain unverified; verification is separate and requires local human approval plus evidence-gated criteria. Operational run/assertion/evidence writes are separate. Bulk `umb memory backfill` remains separately disabled/operator-gated. The demo starter rules are in [`examples/demo-project/memory-patterns-v1.json`](examples/demo-project/memory-patterns-v1.json), configured as `memory.patterns_file: ./memory-patterns-v1.json` relative to `umb.config.yaml` in [`examples/demo-project/umb.config.yaml`](examples/demo-project/umb.config.yaml). The sidecar adds project rules to packaged `python/patterns-v1.json`, which contains five conservative exact entity rules and one relation rule covering PAGE/ACTION/FIELD/RULE only—not all seven ontology labels. A valid empty custom rules file does not remove packaged rules. Invalid configured rules fail closed rather than silently falling back. When NLP health is healthy but effective rules do not support candidate extraction, normalized-only observations may be persisted through an explicitly enabled writer; unhealthy NLP readiness is rejected. Official release bundles include a pinned Python/spaCy runtime and model; there is no source-checkout provisioning command. `umb memory doctor --config ./umb.config.yaml --json` checks runtime/sidecar and existing database health without creating or migrating it; it does not establish actual extraction or packaged-runtime readiness. These capabilities do not establish broad FR-07 completion. `umb doctor` does not check NLP readiness.

## Optional Jira path — not authorized for writes

For Jira-backed work, supply an explicit issue key and configure your Jira MCP independently; use it to read that issue's description/custom fields and, when authorized, for normal Jira comments. UMB has no issue discovery, no general UMB Jira client, and does not configure or replace your Jira MCP. The skill requires the exact supplied key and forbids searching/selecting issues.

UMB's only narrow Jira write surfaces are the experimental CLI screenshot-comment publisher and `jira_publish_screenshot_table` MCP tool. They are not a general reporting client. The CLI is local-only by default; its network path requires both `--write` and `--experimental-inline-wiki`, managed redacted screenshot artifacts, and an HTTPS Jira Cloud origin. Legacy inline-wiki rendering is experimental and not guaranteed generally. Structured MCP writes also require explicit write flags and exact task authorization. Never use either against production. **The prior one-call Jira authorization has been consumed; no further Jira writes are authorized.** This README authorizes no write.

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

Keep credentials out of YAML, shell history, source control, and model-visible arguments; use environment variables/client secret storage. Screenshot artifacts are project-confined, managed under `.umb-managed`, and form fields are masked by default. Authenticated MCP is the default. Browser state is shared across MCP clients, not isolated per client. UMB does not discover Jira issues, transition status, or delete Jira data. The persistent-learning proposal pipeline is implemented through spaCy/redaction/provenance, but runtime writes remain disabled pending final FR-07 integration and evidence gates; candidates remain unverified and verification is separate and requires local human approval plus evidence-gated criteria. Bulk backfill remains separately disabled/operator-gated. Trace capture/artifact export are unimplemented; optional CDP attachment is deferred.

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
