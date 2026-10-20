import type { Command } from 'commander';
import { agentDoctor, installAgentSkill, inspectAgentSkill, uninstallAgentSkill } from './codex.js';

function reportError(error: unknown): void {
  console.error(`Agent command failed safely: ${(error as Error).message}`);
  process.exitCode = 1;
}

export function registerAgentCommands(cli: Command): void {
  const agent = cli.command('agent').description('Manage portable agent skills for Codex and Copilot');
  agent.command('list').description('Show Codex and Copilot skill installation status (read-only)').action(async () => {
    try {
      for (const runtime of ['codex', 'copilot'] as const) for (const scope of ['project', 'user'] as const) {
        const result = await inspectAgentSkill(runtime, scope);
        console.log(`${runtime} ${scope}: ${result.status} (${result.path})`);
      }
    } catch (error) { reportError(error); }
  });
  agent.command('install').description('Install the portable UMB agent skill').requiredOption('--runtime <name>', 'Agent runtime: codex or copilot').requiredOption('--scope <scope>', 'Install scope: project or user').option('--dry-run', 'Show planned changes').option('--force', 'Back up and replace a different existing skill').action(async options => {
    try { console.log(await installAgentSkill({ runtime: options.runtime, scope: options.scope, dryRun: options.dryRun, force: options.force })); }
    catch (error) { reportError(error); }
  });
  agent.command('uninstall').description('Remove the unchanged portable UMB agent skill').requiredOption('--runtime <name>', 'Agent runtime: codex or copilot').requiredOption('--scope <scope>', 'Install scope: project or user').option('--dry-run', 'Show planned changes').action(async options => {
    try { console.log(await uninstallAgentSkill({ runtime: options.runtime, scope: options.scope, dryRun: options.dryRun })); }
    catch (error) { reportError(error); }
  });
  agent.command('doctor').description('Read-only agent skill diagnostics').requiredOption('--runtime <name>', 'Agent runtime: codex or copilot').option('--scope <scope>', 'Check project or user scope').option('--json', 'Output machine-readable diagnostics').action(async options => {
    try {
      if (options.runtime !== 'codex' && options.runtime !== 'copilot') throw new Error(`Unsupported agent runtime "${options.runtime}"; supported runtimes: codex, copilot.`);
      if (options.scope && options.scope !== 'project' && options.scope !== 'user') throw new Error('Scope must be project or user.');
      const result = await agentDoctor(options.runtime, options.scope);
      if (options.json) console.log(JSON.stringify(result));
      else for (const check of result.checks) console.log(`${check.status.toUpperCase()} ${check.id}: ${check.message} ${check.remediation}`);
      if (!result.ok) process.exitCode = 1;
    } catch (error) { reportError(error); }
  });
}
