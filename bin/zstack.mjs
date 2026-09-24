#!/usr/bin/env node

import {
  checkBridgeHealth,
  fetchModelHitchState,
  resolveRoleMapping,
  runRole,
  runPanel,
  syncCursorRules,
  DEFAULT_BRIDGE_URL,
  ZSTACK_ROLES
} from '../src/connector.mjs';

const [,, cmd, ...args] = process.argv;

async function printHelp() {
  console.log(`
zstack — Agent Operating System Harness for ModelHitch
Connected to ModelHitch at ${DEFAULT_BRIDGE_URL}

Usage:
  zstack status                 Check bridge health, active providers, and resolved model roles
  zstack sync [--project]       Sync Cursor rules with active ModelHitch models
  zstack run <role> <prompt>    Send a task to a role's assigned model
  zstack panel <prompt>         Execute parallel review across the multi-family adversarial panel
  zstack models                 List models available in ModelHitch grouped by provider
  zstack help                   Show this help message

Roles:
  feature, bug-fix, fast exploration, judgment and prose, deep reasoning,
  how explorer, how explainer, how critics, why investigators, why synthesizer
`);
}

async function status() {
  console.log('\n=== zstack ModelHitch Harness ===');
  const health = await checkBridgeHealth();
  if (!health.ok) {
    console.error(`[!] Bridge unreachable at ${DEFAULT_BRIDGE_URL}: ${health.error}`);
    console.error(`    Start it with: modelhitch bridge --background\n`);
    process.exit(1);
  }

  console.log(`[✓] ModelHitch Bridge: Online (${health.message})`);

  const state = await fetchModelHitchState();
  const activeProviders = state.activeProviders;
  console.log(`[✓] Active Hitch Providers: ${activeProviders.length ? activeProviders.join(', ') : 'none configured'}`);

  const mapping = resolveRoleMapping(state);
  console.log(`[✓] Operating Mode: ${mapping.mode === 'opencode-zen-go' ? 'OpenCode Zen & Go' : 'ModelHitch Multi-Provider Fallback'}`);
  console.log('\nResolved Role-to-Model Mapping:');
  console.log('--------------------------------------------------------------------------------');
  for (const role of ZSTACK_ROLES) {
    const model = mapping.models[role];
    console.log(`  ${role.padEnd(25)} -> ${model}`);
  }
  console.log('--------------------------------------------------------------------------------\n');
}

async function sync(flags = []) {
  const isProject = flags.includes('--project');
  const state = await fetchModelHitchState();
  const mapping = resolveRoleMapping(state);
  const filePath = syncCursorRules({ mapping, project: isProject });
  console.log(`[✓] Wrote zstack model rule to: ${filePath}`);
}

async function run(role, promptParts) {
  const prompt = promptParts.join(' ');
  if (!role || !prompt) {
    console.error('Error: specify role and prompt. Example: zstack run "feature" "Build token rotation"');
    process.exit(1);
  }

  console.log(`[>] Dispatching to role [${role}] via ModelHitch...`);
  try {
    const res = await runRole(role, prompt);
    console.log(`[✓] Model: ${res.model} (${res.durationMs}ms | ${res.usage.total_tokens} tokens)\n`);
    console.log(res.content);
  } catch (err) {
    console.error(`[!] Execution failed: ${err.message}`);
    process.exit(1);
  }
}

async function panel(promptParts) {
  const prompt = promptParts.join(' ');
  if (!prompt) {
    console.error('Error: specify prompt for panel review. Example: zstack panel "Review this architecture"');
    process.exit(1);
  }

  console.log(`[>] Dispatching adversarial panel review across multi-family models via ModelHitch...\n`);
  try {
    const results = await runPanel(prompt);
    for (const r of results) {
      console.log('================================================================================');
      if (r.ok) {
        console.log(`CRITIQUE: ${r.model} (${r.durationMs}ms | ${r.usage.total_tokens} tokens)`);
        console.log('--------------------------------------------------------------------------------');
        console.log(r.content);
      } else {
        console.log(`CRITIQUE: ${r.model} - FAILED: ${r.error}`);
      }
      console.log('');
    }
  } catch (err) {
    console.error(`[!] Panel failed: ${err.message}`);
    process.exit(1);
  }
}

async function listModels() {
  const state = await fetchModelHitchState();
  const byProvider = {};
  for (const m of state.models) {
    const [p, ...rest] = m.id.split('/');
    if (!byProvider[p]) byProvider[p] = [];
    byProvider[p].push(rest.join('/') || m.id);
  }

  console.log('\nAvailable Models in ModelHitch:');
  for (const [p, list] of Object.entries(byProvider)) {
    console.log(`\n[${p}] (${list.length} models)`);
    for (const id of list.slice(0, 10)) {
      console.log(`  - ${id}`);
    }
    if (list.length > 10) {
      console.log(`    ... and ${list.length - 10} more`);
    }
  }
  console.log('');
}

async function main() {
  switch (cmd) {
    case 'status':
      await status();
      break;
    case 'sync':
      await sync(args);
      break;
    case 'run':
      await run(args[0], args.slice(1));
      break;
    case 'panel':
    case 'arena':
    case 'interrogate':
      await panel(args);
      break;
    case 'models':
      await listModels();
      break;
    case 'help':
    case '--help':
    case '-h':
    default:
      if (!cmd) await status();
      else await printHelp();
      break;
  }
}

main().catch(err => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
