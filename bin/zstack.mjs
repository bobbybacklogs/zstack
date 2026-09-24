#!/usr/bin/env node

import { ZStack, DEFAULT_BRIDGE_URL } from '../src/index.mjs';

const [,, cmd, ...rawArgs] = process.argv;
const z = new ZStack();

// Parse basic flags (--files, --role, --model, --project, --apply, -y, --check)
function parseArgs(args) {
  const flags = { files: [], project: false, apply: false, check: false };
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--project') {
      flags.project = true;
    } else if (arg === '--apply' || arg === '-y') {
      flags.apply = true;
    } else if (arg === '--check') {
      flags.check = true;
    } else if (arg === '--files' && i + 1 < args.length) {
      flags.files = args[++i].split(',').map(s => s.trim());
    } else if (arg === '--role' && i + 1 < args.length) {
      flags.role = args[++i];
    } else if (arg === '--model' && i + 1 < args.length) {
      flags.model = args[++i];
    } else if (arg === '--playbook' && i + 1 < args.length) {
      flags.playbook = args[++i];
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional, text: positional.join(' ') };
}

async function printHelp() {
  console.log(`
zstack — Agent Operating System SDK & CLI for Rigorous Engineering
Connected to ModelHitch at ${DEFAULT_BRIDGE_URL}

Usage:
  zstack "<prompt>"                                Run a task (auto-detects playbook & principles)
  zstack task <playbook> "<prompt>" [options]      Run a task with an explicit playbook
  zstack prompt "<prompt>" [--role <role>]         Send a prompt directly to a model role
  zstack panel "<prompt>"                          Run multi-family adversarial critique in parallel
  zstack status                                    Show ModelHitch health and active role mappings
  zstack sync [--project]                          Sync Cursor rules (~/.cursor/rules/zstack-models.mdc)
  zstack update [--apply]                          Check upstream pstack repository for updates
  zstack playbooks                                 List all 15 execution playbooks
  zstack principles                                List the 20 engineering principles
  zstack --about                                   Show system architecture, tenets, and metadata
  zstack help                                      Show this help message

Options:
  --files <path1,path2>    Attach local file context to the task
  --role <role>            Override role assignment (e.g., 'feature, refactoring', 'judgment and prose')
  --model <provider/model> Override model directly (e.g., 'deepseek/deepseek-v4-flash')
  --project                Target current project directory instead of user home
  --apply, -y              Automatically record upstream sync checkpoint
  --check                  Check upstream without prompting for update
  --about, -a              Show architecture and design overview
  --version, -v            Show package version
`);
}

async function handleStatus() {
  console.log('\n=== zstack ModelHitch Harness ===');
  const res = await z.status();
  if (!res.ok) {
    console.error(`[!] Bridge unreachable at ${res.baseUrl}: ${res.error}`);
    console.error(`    Start it with: modelhitch bridge --background\n`);
    process.exit(1);
  }

  console.log(`[✓] ModelHitch Bridge: Online (${res.message})`);
  console.log(`[✓] Active Hitch Providers: ${res.activeProviders?.join(', ') || 'none'}`);
  console.log(`[✓] Operating Mode: ${res.mode === 'opencode-zen-go' ? 'OpenCode Zen & Go' : 'ModelHitch Multi-Provider'}`);
  console.log('\nResolved Role-to-Model Mapping:');
  console.log('--------------------------------------------------------------------------------');
  for (const [role, model] of Object.entries(res.mapping || {})) {
    console.log(`  ${role.padEnd(25)} -> ${model}`);
  }
  console.log('--------------------------------------------------------------------------------\n');
}

async function handlePlaybooks() {
  const list = z.listPlaybooks();
  console.log('\n=== zstack Execution Playbooks ===\n');
  for (const p of list) {
    console.log(`  ${p.id.padEnd(20)} ${p.trigger}`);
  }
  console.log(`\nTotal: ${list.length} playbooks in playbooks/\n`);
}

async function handlePrinciples() {
  const list = z.listPrinciples();
  console.log('\n=== zstack 20 Engineering Principles ===\n');
  for (const p of list) {
    console.log(`  ${p.id.padEnd(36)} ${p.applyWhen}`);
  }
  console.log(`\nTotal: ${list.length} principles in principles/\n`);
}

async function handleSync(args) {
  const { flags } = parseArgs(args);
  const filePath = await z.syncRules({ project: flags.project });
  console.log(`[✓] Wrote zstack model rule to: ${filePath}`);
}

async function handleTask(playbookArg, restArgs) {
  const { flags, text } = parseArgs(restArgs);
  const prompt = text;
  if (!prompt) {
    console.error('Error: task requires a prompt description. Example: zstack task bug-fix "Fix token retry loop"');
    process.exit(1);
  }

  console.log(`[>] Running task with playbook [${playbookArg}]...`);
  try {
    const res = await z.task({
      playbook: playbookArg,
      prompt,
      files: flags.files,
      role: flags.role,
      model: flags.model
    });
    console.log(`[✓] Model: ${res.model} | Role: ${res.role} (${res.durationMs}ms | ${res.usage.total_tokens} tokens)\n`);
    console.log(res.content);
  } catch (err) {
    console.error(`[!] Task failed: ${err.message}`);
    process.exit(1);
  }
}

async function handleOneShotPrompt(args) {
  const { flags, text } = parseArgs(args);
  const prompt = text;
  if (!prompt) {
    await printHelp();
    return;
  }

  const classification = z.classifyPrompt(prompt);
  console.log(`[>] Task classified as [${classification.type}] (playbook: ${classification.playbookFile})`);
  console.log(`    Principles: ${classification.principles.join(', ')}`);

  try {
    const res = await z.task({
      prompt,
      playbook: flags.playbook || classification.type,
      files: flags.files,
      role: flags.role,
      model: flags.model
    });
    console.log(`[✓] Model: ${res.model} | Role: ${res.role} (${res.durationMs}ms | ${res.usage.total_tokens} tokens)\n`);
    console.log(res.content);
  } catch (err) {
    console.error(`[!] Execution failed: ${err.message}`);
    process.exit(1);
  }
}

async function handlePanel(args) {
  const { text } = parseArgs(args);
  if (!text) {
    console.error('Error: panel review requires a prompt or architecture topic.');
    process.exit(1);
  }

  console.log(`[>] Dispatching adversarial panel review across multi-family models via ModelHitch...\n`);
  try {
    const results = await z.panel(text);
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

function handleAbout() {
  const meta = z.about();
  console.log(`
zstack — Agent Operating System for Rigorous Engineering
Version:     ${meta.version} (ESM, TypeScript types included)
License:     ${meta.license}
Repository:  ${meta.repository}
Gateway:     ${meta.gateway}

Overview:
  zstack is an opinionated, verification-first operating system, SDK, and CLI
  for AI coding agents. Inspired by Lauren Tan's pstack/poteto-mode methodology,
  zstack replaces unverified code generation with structured execution, durable
  engineering principles, and workload-specific model routing.

Subsystems:
  - Task Playbooks (${meta.playbookCount} SOPs)
    Structured execution procedures for features, bug-fixes, refactoring,
    performance diagnostics, runtime forensics, and PR packaging.
  - Durable Principles (${meta.principleCount} Rules)
    Non-negotiable engineering constraints (laziness protocol, root cause
    remediation, boundary discipline, context preservation) cited against
    concrete code decisions.
  - Workload-Specific Model Routing
    Decouples agent engineering roles from individual models. Routes fast code
    generation to high-throughput models, architectural synthesis to frontier
    reasoning models, and adversarial critiques to multi-family panels.
  - ModelHitch Integration (http://127.0.0.1:3939/v1)
    Normalizes multi-wire endpoints (OpenAI, Anthropic Messages, Gemini
    GenerateContent, Codex Responses) through a local BYOK proxy with automatic
    circuit breaking, failover, and token/cost telemetry.

Core Tenets:
  - Verify against real artifacts (live processes, HTTP responses, test output),
    never self-reports or unit mocks.
  - Delete before writing: the best diff is negative lines of code.
  - Make illegal states unrepresentable with strict boundary schemas and tagged unions.
  - Write unslopped declarative prose with short, active sentences and no em-dashes.
`);
}

async function main() {
  switch (cmd) {
    case 'status':
      await handleStatus();
      break;
    case 'about':
    case '--about':
    case '-a':
      handleAbout();
      break;
    case 'version':
    case '--version':
    case '-v':
      console.log('zstack v0.1.0');
      break;
    case 'playbooks':
      await handlePlaybooks();
      break;
    case 'principles':
      await handlePrinciples();
      break;
    case 'sync':
      await handleSync(rawArgs);
      break;
    case 'update':
    case '--update': {
      const { flags } = parseArgs(rawArgs);
      await z.update({ apply: flags.apply, check: flags.check });
      break;
    }
    case 'task':
      await handleTask(rawArgs[0], rawArgs.slice(1));
      break;
    case 'panel':
    case 'arena':
    case 'interrogate':
      await handlePanel(rawArgs);
      break;
    case 'prompt':
    case 'run':
      await handleOneShotPrompt(rawArgs);
      break;
    case 'help':
    case '--help':
    case '-h':
      await printHelp();
      break;
    default:
      if (!cmd) {
        await handleStatus();
      } else {
        // Treat as a direct task prompt: zstack "my task prompt..."
        await handleOneShotPrompt([cmd, ...rawArgs]);
      }
      break;
  }
}

main().catch(err => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});

