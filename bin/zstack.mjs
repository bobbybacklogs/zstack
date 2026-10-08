#!/usr/bin/env node

import { createInterface } from 'node:readline/promises';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { ZStack, DEFAULT_BRIDGE_URL, fetchModelHitchState } from '../src/index.mjs';
import { BUDGET_TIERS, BUDGET_SOURCES, LANES, getStoredBudget, isKnownLane, normalizeLane, promptAndSetBudget } from '../src/budget.mjs';
import { resolveHuggingFaceLane, describeHuggingFaceFilter, isHuggingFaceModel, hasHuggingFaceKey } from '../src/hf.mjs';
import { gradeDiff, formatVerdictTable } from '../src/grader.mjs';
import { appendHistory, readHistory, lastEntry, needsRerunConfirm, HISTORY_PREVIEW_CHARS, newRunId, checkpointHistory, removeHistoryCheckpoint } from '../src/history.mjs';
import { createLiveRun, applyLiveEvent } from '../src/blocks.mjs';
import { historyRecordFor, normalizeStartRequest, collectHistoryEvent } from '../src/runs.mjs';
import { triageFailure } from '../src/triage.mjs';
import { runContextOffload, formatOffloadReport } from '../src/subagent.mjs';
import { formatEventLine, createProgressRenderer, explainEmptyContent, resolveHarnessEntry, harnessEntryExists, observeGitStatus } from '../src/harness.mjs';
import { startServer, stopServer, DEFAULT_PORT, DEFAULT_HOST, isLoopback, envTruthy } from '../src/serve.mjs';
import { DEFAULT_MAX_TURNS, continuationBudget, runWithExtensions } from '../src/turns.mjs';
import { commitAndPushBranch } from '../src/git.mjs';
import { createPullRequest } from '../src/github.mjs';
import {
  readSchedules,
  writeSchedules,
  createSchedule,
  updateSchedule,
  deleteSchedule,
  findSchedule,
  validateCron,
  computeNextRun,
  describeCron,
  inferScheduleFromText,
  Scheduler
} from '../src/schedules.mjs';
import {
  getWorkfolkStatus,
  fetchWorkfolkRoster,
  dispatchWorkfolkTask,
  getWorkfolkJobStatus,
  pollWorkfolkJob,
  getWorkfolkConfig
} from '../src/workfolk.mjs';
import {
  readKeys,
  createKey,
  rotateKey,
  updateKey,
  deleteKey,
  findKey,
  verifyKeySecret,
  publicKey,
  keysPath
} from '../src/keys.mjs';

/** Structured exit codes: 0 success, 1 failure, 2 usage, 3 gateway, 4 partial. */
export const EXIT = { OK: 0, FAIL: 1, USAGE: 2, GATEWAY: 3, PARTIAL: 4 };

/** Map gateway failure kinds to the documented exit codes. */
export function exitForKind(kind) {
  if (kind === 'unreachable' || kind === 'timeout') return EXIT.GATEWAY;
  return EXIT.FAIL; // http, parse, unknown
}

const KNOWN_COMMANDS = new Set([
  'task', 'prompt', 'run', 'panel', 'arena', 'interrogate', 'budget', 'grade',
  'triage', 'explore', 'history', 'shell', 'repl', 'serve', 'skill', 'schedule', 'schedules', 'cron',
  'workfolk', 'workers', 'keys', 'key', 'apikeys',
  'status', 'sync', 'update', 'playbooks', 'principles', 'about', 'version', 'help'
]);

const z = new ZStack();

// Parse flags (--files, --role, --model, --project, --apply, -y, --check,
// --tier, --source, --confirm, --json, --no-prune, --context-budget, --file,
// --playbook, --timeout, --paths, --max-files, --limit, --last, --rerun, --live,
// --agent, --max-turns, --review)
function parseArgs(args) {
  const flags = { files: [], project: false, apply: false, check: false, confirm: false, yes: false, json: false, noPrune: false, live: true, last: false, rerun: false, agent: false, review: false, autoPr: false, dryRun: false, force: false, wait: false, includeRetired: false };
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--project') {
      flags.project = true;
    } else if (arg === '--agent') {
      flags.agent = true;
    } else if (arg === '--pr' || arg === '--auto-pr') {
      flags.autoPr = true;
      flags.agent = true;
    } else if (arg === '--review') {
      flags.review = true;
      // Same reasoning as the budget: a reviewer that reviews nothing is a
      // flag that lies about what it did.
      flags.agent = true;
    } else if (arg === '--max-turns' && i + 1 < args.length) {
      const n = Number(args[++i]);
      if (!Number.isInteger(n) || n <= 0) {
        flags.maxTurnsError = args[i];
      } else {
        flags.maxTurns = n;
        // A budget only means something if the loop runs. Accepting the flag on
        // a single completion turned it into a silent no-op, which is the same
        // trap `--project --apply` used to be.
        flags.agent = true;
      }
    } else if (arg === '--continue') {
      // Resumes the most recent run that saved a session. A boolean rather
      // than an optional value: the prompt is positional, so `--continue <id>`
      // would have to guess whether the next word is an id or the task.
      flags.continue = true;
      flags.agent = true;
    } else if (arg === '--confirm' || arg === '--yes') {
      flags.confirm = true;
      flags.yes = true;
      flags.apply = true;
    } else if (arg === '--apply' || arg === '-y') {
      flags.apply = true;
    } else if (arg === '--check') {
      flags.check = true;
    } else if (arg === '--json') {
      flags.json = true;
    } else if (arg === '--no-prune') {
      flags.noPrune = true;
    } else if (arg === '--context-budget' && i + 1 < args.length) {
      const n = Number(args[++i]);
      if (!Number.isFinite(n) || n <= 0) {
        flags.contextBudgetError = args[i];
      } else {
        flags.contextBudget = Math.floor(n);
      }
    } else if (arg === '--timeout' && i + 1 < args.length) {
      const n = Number(args[++i]);
      if (!Number.isFinite(n) || n <= 0) {
        flags.timeoutError = args[i];
      } else {
        flags.timeoutMs = Math.floor(n);
      }
    } else if (arg === '--tier' && i + 1 < args.length) {
      flags.tier = args[++i].toLowerCase();
    } else if (arg === '--source' && i + 1 < args.length) {
      flags.source = args[++i].toLowerCase();
    } else if (arg === '--lane' && i + 1 < args.length) {
      flags.lane = args[++i].toLowerCase();
    } else if (arg === '--zen' || arg === '--go' || arg === '--hitch' || arg === '--hf') {
      flags.lane = arg.slice(2);
    } else if (arg === '--file' && i + 1 < args.length) {
      flags.file = args[++i];
    } else if (arg === '--paths' && i + 1 < args.length) {
      flags.paths = args[++i].split(',').map(s => s.trim()).filter(Boolean);
    } else if (arg === '--max-files' && i + 1 < args.length) {
      const n = Number(args[++i]);
      if (!Number.isInteger(n) || n <= 0) {
        flags.maxFilesError = args[i];
      } else {
        flags.maxFiles = n;
      }
    } else if (arg === '--limit' && i + 1 < args.length) {
      const n = Number(args[++i]);
      if (!Number.isInteger(n) || n <= 0) {
        flags.limitError = args[i];
      } else {
        flags.limit = n;
      }
    } else if (arg === '--last') {
      flags.last = true;
    } else if (arg === '--steps') {
      flags.steps = true;
    } else if (arg === '--rerun') {
      flags.rerun = true;
    } else if (arg === '--live') {
      flags.live = true;
    } else if (arg === '--no-live') {
      flags.live = false;
    } else if (arg === '--files' && i + 1 < args.length) {
      flags.files = args[++i].split(',').map(s => s.trim());
    } else if (arg === '--role' && i + 1 < args.length) {
      flags.role = args[++i];
    } else if (arg === '--model' && i + 1 < args.length) {
      flags.model = args[++i];
    } else if (arg === '--playbook' && i + 1 < args.length) {
      flags.playbook = args[++i];
    } else if (arg === '--port' && i + 1 < args.length) {
      const n = Number(args[++i]);
      if (!Number.isInteger(n) || n < 0 || n > 65535) {
        flags.portError = args[i];
      } else {
        flags.port = n;
      }
    } else if (arg === '--host' && i + 1 < args.length) {
      flags.host = args[++i];
    } else if (arg === '--open') {
      flags.open = true;
    } else if (arg === '--out' && i + 1 < args.length) {
      flags.out = args[++i];
    } else if (arg === '--dry-run') {
      flags.dryRun = true;
    } else if (arg === '--force') {
      flags.force = true;
    } else if (arg === '--cron' && i + 1 < args.length) {
      flags.cron = args[++i];
    } else if (arg === '--name' && i + 1 < args.length) {
      flags.name = args[++i];
    } else if ((arg === '--assign' || arg === '--to') && i + 1 < args.length) {
      flags.assign = args[++i];
    } else if (arg === '--notes' && i + 1 < args.length) {
      flags.notes = args[++i];
    } else if (arg === '--expires' && i + 1 < args.length) {
      const n = Number(args[++i]);
      if (!Number.isFinite(n) || n <= 0) {
        flags.expiresError = args[i];
      } else {
        flags.expires = Math.floor(n);
      }
    } else if (arg === '--require-auth') {
      flags.requireAuth = true;
    } else if (arg === '--disabled') {
      flags.disabled = true;
    } else if (arg === '--enabled') {
      flags.enabled = true;
    } else if (arg === '--policy' && i + 1 < args.length) {
      flags.policy = args[++i];
    } else if (arg === '--project-id' && i + 1 < args.length) {
      flags.projectId = args[++i];
    } else if (arg === '--wait') {
      flags.wait = true;
    } else if (arg === '--include-retired') {
      flags.includeRetired = true;
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional, text: positional.join(' ') };
}

/** Split leading global flags from the subcommand so `zstack --json status` works. */
function splitCmd(argv) {
  const { positional } = parseArgs(argv);
  const cmd = positional[0];
  if (!cmd) return { cmd: undefined, rawArgs: argv };
  const idx = argv.indexOf(cmd);
  const rawArgs = argv.filter((_, i) => i !== idx);
  return { cmd, rawArgs };
}

function emitJson(obj) {
  console.log(JSON.stringify(obj));
}

function jsonError(message, code, extra = {}) {
  emitJson({ ok: false, error: message, ...extra });
  process.exit(code);
}

/** Human-mode error (stderr) or JSON error object with the documented exit code. */
function fail(message, code, flags) {
  if (flags?.json) jsonError(message, code);
  console.error(message);
  process.exit(code);
}

/** Fail from a caught error, mapping gateway kinds to exit codes. */
function failWith(err, flags, fallback = EXIT.FAIL, prefix = '[!] Task failed') {
  const code = err?.kind ? exitForKind(err.kind) : fallback;
  fail(`${prefix}: ${err?.message || err}`, code, flags);
}

/**
 * Persist one history line per run. Best-effort: appendHistory warns once and
 * never throws, so recording cannot fail the underlying task.
 */
function recordRun(fields) {
  try {
    const saved = appendHistory(fields);
    if (saved && fields.id) removeHistoryCheckpoint(fields.id);
    return saved;
  } catch {
    // History is advisory; the task result stands on its own.
  }
}

function exitCodeFor(err) {
  return err?.kind ? exitForKind(err.kind) : EXIT.FAIL;
}

function gatewayUnreachable(res, flags) {
  const message = `Bridge unreachable at ${res.baseUrl}: ${res.error}`;
  if (flags?.json) jsonError(message, EXIT.GATEWAY, { baseUrl: res.baseUrl });
  console.error(`[!] ${message}`);
  console.error(`    Start it with: modelhitch bridge --background\n`);
  process.exit(EXIT.GATEWAY);
}

function contextFlags(flags) {
  if (flags.contextBudgetError !== undefined) {
    fail(`Error: --context-budget expects a positive token count (got "${flags.contextBudgetError}").`, EXIT.USAGE, flags);
  }
  if (flags.timeoutError !== undefined) {
    fail(`Error: --timeout expects a positive millisecond count (got "${flags.timeoutError}").`, EXIT.USAGE, flags);
  }
  return { contextBudget: flags.contextBudget, noPrune: flags.noPrune || undefined };
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
  zstack budget [tier] [--source config|catalog] [--lane auto|zen|go|hitch|hf] [--confirm]
                                                   Preview + confirm model budget mapping
  zstack hf [--tier <tier>] [--json] [--all]       Show the HuggingFace lane's model filter
  zstack grade [--file <diff>] [--json]            Grade a diff against the 20 principles
  zstack triage [--file <log>] [--json]            Rank playbooks for failure output
  zstack explore "<query>" [--paths src,tests]     Distill bulk file reads via a subagent
  zstack history [--limit N] [--steps] [--json]    Show recent runs (--last --rerun repeats)
  zstack keys [list] [--json]                      List API keys, what they are for, and last use
  zstack keys new "<name>" [options]               Mint a key (secret printed once, never stored)
  zstack keys show <id|name|prefix>                Show one key's metadata
  zstack keys rotate <id|name|prefix>              Issue a new secret; the old one dies immediately
  zstack keys rename|assign <id> [options]         Rename a key or record where it is deployed
  zstack keys delete <id> [--yes]                  Retire a key so it authenticates nothing
  zstack keys verify "<secret>"                    Check whether a secret still authenticates
  zstack serve [--port N] [--host H] [--open]      Local UI: browse runs, watch one live, start one
  zstack serve --require-auth                      Refuse API calls that present no key or token
  zstack shell | repl                              Start an interactive session with sticky context
  zstack skill <playbook-id> [--out <dir>] [--dry-run] [--force]
                                                   Package a playbook into a SKILL.md
  zstack schedule list [--json]                    List scheduled routines and next run times
  zstack schedule add "<prompt>" [options]         Add a routine (infers cadence or use --cron)
  zstack schedule run <id> [--json]                Trigger a scheduled routine immediately
  zstack schedule enable <id> | disable <id>       Enable or pause a scheduled routine
  zstack schedule delete <id>                      Delete a scheduled routine
  zstack schedule infer "<text>"                   Infer cron cadence and task from natural language
  zstack workfolk [list] [--json]                  List Workfolk worker roster and capabilities
  zstack workfolk dispatch <tag> "<task>" [--wait] Dispatch a task to a Workfolk specialist
  zstack workfolk job <id> [--wait] [--json]       Query status and result of a Workfolk job
  zstack workfolk status [--json]                  Check Workfolk gateway connectivity and auth
  zstack status [--json]                           Show ModelHitch health and active role mappings
  zstack sync [--project]                          Sync Cursor rules (~/.cursor/rules/zstack-models.mdc)
  zstack update [--apply]                          Check upstream pstack repository for updates
  zstack playbooks [--json]                        List all 15 execution playbooks
  zstack principles [--json]                       List the 20 engineering principles
  zstack --about                                   Show system architecture, tenets, and metadata
  zstack help                                      Show this help message

  Budget tiers: low-med | med-high | high | max (confirmation required before apply)
  Budget sources:
    config   Option A: strictly use models pinned in ModelHitch config policies
    catalog  Option B: use active providers but pick best tier models from catalog

  Provider lanes (which provider family role models resolve from):
    auto     Default: OpenCode Zen when an OpenCode key is active, else hitch
    zen      OpenCode Zen pay-per-use  (opencode/<model>)
    go       OpenCode Go flat-rate    (opencode-go/<model>)
    hitch    No OpenCode preference: ModelHitch active providers / config default
    hf       HuggingFace router       (huggingface/<org>/<model>)
             An open catalogue, so the lane filters it for tool calling,
             context, and recency before pinning any role. Run \`zstack hf\` to
             see what the filter admitted, what it rejected, and why.
  Shortcuts: --zen, --go, --hitch, --hf. A single request can override the stored
  lane, for example: zstack --go "Fix the flaky retry test"

  Prompt classification: confident matches run directly; ambiguous matches offer
  guided playbook selection (threshold: top score >= 1.0 with >= 0.5 margin).
  The semantic router refines ambiguous matches when the gateway is reachable.

  Agentic runs (the tool loop):
    A plain prompt makes one model call and prints the reply: it cannot read or
    change anything. Adding --agent, --apply, or --project instead runs the
    ModelHitch harness, which gives the model tools, executes its calls, and
    feeds the results back until the task is done or --max-turns is reached.
    Every turn and tool call streams as it happens and is recorded in history
    (see: zstack history --steps).
      read-only (default)  Commands the harness risk-classifies safe run;
                           anything that could write or reach the network is
                           declined, and the run reports what it declined.
      --apply              Approves mutating calls, so the agent can change
                           files. Diffs are reported from writer tools and from
                           git status when the workspace is a repository.

Options:
  --tier <tier>              Budget tier (low-med, med-high, high, max)
  --source <config|catalog>  Model selection source (Option A vs Option B)
  --lane <auto|zen|go|hitch|hf> Provider lane for this invocation (overrides stored lane)
  --zen, --go, --hitch, --hf Shortcuts for --lane zen | go | hitch | hf
  --agent                    Run the agentic tool loop (single completion without it)
  --apply, -y                Agent: approve mutating calls so files can change
                             (also: zstack update, record upstream sync checkpoint)
  --max-turns <n>            Agent: model turns before the loop stops
                             (default 25; the harness alone would use 8)
  --continue                 Agent: resume the most recent run that saved a session,
                             with a doubled budget. The task prompt is the next
                             instruction, not a repeat of the original.
  --review                   Agent: run the read-only reviewer over the change afterwards
  --pr, --auto-pr            Agent: open a GitHub pull request on completion if changes are made
  --confirm, --yes, -y       Confirm and apply budget mapping without interactive prompt
  --json                     Emit a single JSON document on stdout (diagnostics to stderr)
  --timeout <ms>             Per-request gateway timeout (default 30000, env MODELHITCH_TIMEOUT)
  --no-prune                 Abort instead of trimming when over the context budget
  --context-budget <tokens>  Context window budget in tokens (default 12000)
  --file <path>              Read grade/triage input from a file
  --paths <a,b>              Restrict explore to these paths (default: .)
  --max-files <n>            Cap explore file attachments (positive integer)
  --limit <n>                History entries to show, newest first (positive integer)
  --steps                    History: expand each agentic run into its steps
  --last                     History: show only the last run
  --rerun                    History: re-dispatch the last run (--yes if preview truncated)
  --live / --no-live         Triage: use the gateway model (default live) or heuristic only
  --files <path1,path2>    Attach local file context to the task
  --role <role>            Override role assignment (e.g., 'feature, refactoring', 'judgment and prose')
  --model <provider/model> Override model directly (e.g., 'deepseek/deepseek-v4-flash')
  --playbook <id>          Bypass guided selection with an explicit playbook
  --project                Agent: run in the current directory reading/writing real files
  --check                  Check upstream without prompting for update
  --out <dir>              Skill: target directory for packaged SKILL.md
  --dry-run                Skill: print generated SKILL.md to stdout without writing
  --force                  Skill: overwrite existing target and bypass cross-location collisions
  --cron "<expr>"          Schedule: cron expression (e.g. '0 9 * * 1-5' or '@hourly')
  --policy <read-only|apply> Schedule: execution policy (default read-only)
  --disabled               Schedule: create routine in paused state
  --name "<name>"          Keys: the key's name (or pass it positionally)
  --assign "<where>"       Keys: site, server, or integration the key is deployed to
  --notes "<text>"         Keys: free-form notes kept with the key
  --expires <days>         Keys: expire the key this many days from now
  --require-auth           Serve: require a key or token on every API call
  --about, -a              Show architecture and design overview
  --version, -v            Show package version

Exit codes: 0 success · 1 failure · 2 usage error · 3 gateway unreachable · 4 partial (panel)
`);
}

async function handleStatus(args) {
  const { flags } = parseArgs(args);
  const res = await z.status();
  if (!res.ok) gatewayUnreachable(res, flags);
  if (flags.json) {
    emitJson({
      ok: true, baseUrl: res.baseUrl, message: res.message,
      activeProviders: res.activeProviders, mode: res.mode,
      lane: res.lane ?? null,
      mapping: res.mapping, panelModels: res.panelModels, budget: res.budget ?? null
    });
    return;
  }

  console.log('\n=== zstack ModelHitch Harness ===');
  console.log(`[✓] ModelHitch Bridge: Online (${res.message})`);
  console.log(`[✓] Active Hitch Providers: ${res.activeProviders?.join(', ') || 'none'}`);
  console.log(`[✓] Provider Lane: ${res.laneInfo?.name || res.lane || 'auto'} (${res.mode})`);
  if (res.budget) {
    console.log(`[✓] Budget: ${res.budget.tier} (source: ${res.budget.source}) — change with: zstack budget --tier <low-med|med-high|high|max>`);
  }
  console.log('\nResolved Role-to-Model Mapping:');
  console.log('--------------------------------------------------------------------------------');
  for (const [role, model] of Object.entries(res.mapping || {})) {
    console.log(`  ${role.padEnd(25)} -> ${model}`);
  }
  console.log('--------------------------------------------------------------------------------\n');
}

async function handlePlaybooks(args) {
  const { flags } = parseArgs(args);
  const list = z.listPlaybooks();
  if (flags.json) {
    emitJson({ ok: true, count: list.length, playbooks: list });
    return;
  }
  console.log('\n=== zstack Execution Playbooks ===\n');
  for (const p of list) {
    console.log(`  ${p.id.padEnd(20)} ${p.trigger}`);
  }
  console.log(`\nTotal: ${list.length} playbooks in playbooks/\n`);
}

async function handlePrinciples(args) {
  const { flags } = parseArgs(args);
  const list = z.listPrinciples();
  if (flags.json) {
    emitJson({ ok: true, count: list.length, principles: list });
    return;
  }
  console.log('\n=== zstack 20 Engineering Principles ===\n');
  for (const p of list) {
    console.log(`  ${p.id.padEnd(36)} ${p.applyWhen}`);
  }
  console.log(`\nTotal: ${list.length} principles in principles/\n`);
}

async function handleSkill(args) {
  const { flags, positional } = parseArgs(args);
  const playbookId = positional[0];
  if (!playbookId) {
    fail('Error: skill requires a playbook id. Usage: zstack skill <playbook-id> [--out <dir>] [--dry-run] [--force]', EXIT.USAGE, flags);
  }

  try {
    const res = z.packageSkill({
      playbookId,
      outDir: flags.out,
      dryRun: flags.dryRun,
      force: flags.force
    });

    if (flags.dryRun) {
      if (flags.json) {
        emitJson({ ok: true, dryRun: true, skill: res.skill, principles: res.principles, content: res.content });
      } else {
        process.stdout.write(res.content);
      }
      return;
    }

    if (flags.json) {
      emitJson({
        ok: true,
        skill: res.skill,
        file: res.targetFile,
        files: res.files,
        principles: res.principles,
        dryRun: false
      });
      return;
    }

    console.log(`\n[✓] Packaged skill [${res.skill}] -> ${res.targetFile}`);
    console.log(`    Principles resolved (${res.principles.length}): ${res.principles.join(', ')}`);
    console.log('    Files written:');
    for (const f of res.files) {
      console.log(`      ~ ${f}`);
    }
    console.log('');
  } catch (err) {
    failWith(err, flags, EXIT.FAIL, '[!] Skill packaging failed');
  }
}

async function handleSync(args) {
  const { flags } = parseArgs(args);
  try {
    const filePath = await z.syncRules({ project: flags.project, lane: flags.lane });
    if (flags.json) {
      emitJson({ ok: true, rulePath: filePath });
      return;
    }
    console.log(`[✓] Wrote zstack model rule to: ${filePath}`);
  } catch (err) {
    failWith(err, flags, EXIT.FAIL, '[!] Sync failed');
  }
}

function taskOptions(prompt, playbook, flags) {
  return {
    playbook,
    prompt,
    files: flags.files,
    role: flags.role,
    model: flags.model,
    lane: flags.lane,
    ...contextFlags(flags)
  };
}

/**
 * Whether this invocation runs the agent loop instead of a single completion.
 *
 * `task` cannot change anything: it makes one request and returns text. So any
 * flag that only means something if work actually happens implies an agentic
 * run. Turning them into silent no-ops is what made `--project --apply` look
 * like it had run when nothing had been touched.
 */
function isAgentic(flags) {
  return !!(flags.agent || flags.apply || flags.project || flags.autoPr);
}

function agentOptions(prompt, playbook, flags) {
  return {
    playbook,
    prompt,
    role: flags.role,
    model: flags.model,
    lane: flags.lane,
    apply: !!flags.apply,
    maxTurns: flags.maxTurns,
    review: !!flags.review,
    workspaceDir: flags.project ? process.cwd() : undefined
  };
}

function reportContext(plan, flags) {
  if (!plan) return;
  const lines = [];
  if (plan.budgetTokens) lines.push(`Context: ~${plan.estimatedTokens} / ${plan.budgetTokens} tokens`);
  for (const t of plan.trimmed || []) lines.push(`Context trim: ${t}`);
  if (plan.omittedPrinciples?.length > 0) lines.push(`Context: omitted principles: ${plan.omittedPrinciples.join(', ')}`);
  if (lines.length === 0) return;
  if (flags.json) {
    console.error(lines.join('\n'));
  } else {
    console.log(lines.map(l => `    ${l}`).join('\n'));
  }
}

async function handleTask(args) {
  const { flags, positional } = parseArgs(args);
  const playbookArg = positional[0];
  const prompt = positional.slice(1).join(' ');
  if (!playbookArg || !prompt) {
    fail('Error: task requires a playbook and prompt. Example: zstack task bug-fix "Fix token retry loop"', EXIT.USAGE, flags);
  }

  if (!flags.json) console.log(`[>] Running task with playbook [${playbookArg}]...`);
  else console.error(`Running task with playbook [${playbookArg}]...`);

  // Same rule as the bare-prompt path: a flag that only matters if work happens
  // selects the agent loop.
  if (isAgentic(flags)) {
    const classification = z.classifyPromptDetailed(prompt);
    return await runAgentPrompt(prompt, playbookArg, classification, flags);
  }

  try {
    const res = await z.task(taskOptions(prompt, playbookArg, flags));
    recordRun({
      command: 'task',
      playbook: res.playbook,
      role: res.role,
      model: res.model,
      durationMs: res.durationMs,
      usage: res.usage,
      contextEstimate: res.context?.estimatedTokens ?? null,
      promptChars: prompt.length,
      promptPreview: prompt,
      files: flags.files || [],
      ok: true
    });
    if (flags.json) {
      emitJson({
        ok: true, content: res.content, model: res.model, role: res.role,
        playbook: res.playbook, principles: res.principles,
        classification: res.classification ?? null, context: res.context ?? null,
        usage: res.usage, durationMs: res.durationMs
      });
      return;
    }
    reportContext(res.context, flags);
    console.log(`[✓] Model: ${res.model} | Role: ${res.role} (${res.durationMs}ms | ${res.usage.total_tokens} tokens)\n`);
    console.log(res.content);
  } catch (err) {
    recordRun({
      command: 'task',
      playbook: playbookArg,
      role: flags.role || null,
      model: null,
      durationMs: null,
      usage: null,
      contextEstimate: null,
      promptChars: prompt.length,
      promptPreview: prompt,
      files: flags.files || [],
      ok: false,
      errorKind: err?.kind || 'error',
      exitCode: exitCodeFor(err)
    });
    failWith(err, flags, EXIT.FAIL, '[!] Task failed');
  }
}

/**
 * Guided playbook selection: confident matches run directly; ambiguous matches
 * print ranked candidates and prompt (number, id, or Enter for top).
 * Pass a shared asker ({ question, close }) in shell mode to prompt on the
 * session reader without closing it. A null answer (EOF) falls back to top.
 */
async function resolveGuidedPlaybook(prompt, flags, asker) {
  const detailed = z.classifyPromptDetailed(prompt);
  if (flags.playbook) {
    return { playbookId: flags.playbook, classification: detailed, guided: false };
  }
  if (!detailed.ambiguous) {
    return { playbookId: detailed.type, classification: detailed, guided: false };
  }
  const playbooks = z.listPlaybooks();
  const triggerOf = id => playbooks.find(p => p.id === id)?.trigger || 'General task';
  const showCandidates = () => {
    console.log(`[?] Ambiguous prompt (top score ${detailed.confidence}). Candidates:`);
    detailed.candidates.forEach((c, i) => {
      console.log(`    ${i + 1}. ${c.type} (score ${c.score}, ${c.reason})`);
      console.log(`       trigger: ${triggerOf(c.type)}`);
    });
  };
  // Without a session asker, --json (or any non-interactive stream) disables
  // prompting: use the top candidate. Shell mode always prompts via its asker.
  if (!asker && (flags.json || !process.stdin.isTTY)) {
    const warn = `[!] Ambiguous classification; using top candidate [${detailed.type}] without prompting (non-interactive).`;
    if (flags.json) console.error(warn);
    else console.log(warn);
    return { playbookId: detailed.type, classification: detailed, guided: true };
  }
  showCandidates();
  const nativeRl = asker ? null : createInterface({ input: process.stdin, output: process.stdout });
  const ask = asker || {
    question: p => nativeRl.question(p),
    close: () => nativeRl.close()
  };
  const pick = raw => {
    const v = String(raw || '').trim().toLowerCase();
    if (!v) return detailed.type;
    const n = Number(v);
    if (Number.isInteger(n) && n >= 1 && n <= detailed.candidates.length) {
      return detailed.candidates[n - 1].type;
    }
    const byId = detailed.candidates.find(c => c.type.toLowerCase() === v);
    if (byId) return byId.type;
    return null;
  };
  try {
    const first = await ask.question('Select playbook [number, id, or Enter for top]: ');
    let selected = pick(first);
    if (!selected) {
      console.log(`[!] Invalid selection "${String(first).trim()}". One retry.`);
      const second = await ask.question('Select playbook [number, id, or Enter for top]: ');
      selected = pick(second);
    }
    if (!selected) {
      console.log(`[!] Invalid selection again; falling back to top candidate [${detailed.type}].`);
      selected = detailed.type;
    }
    return { playbookId: selected, classification: detailed, guided: true };
  } finally {
    if (!asker) ask.close();
  }
}

/**
 * Agentic execution: run the tool loop and stream its progression.
 *
 * The stream is the point. Once zstack executes tool calls, "what did it do?"
 * stops being answerable from the final message, so every turn and tool call is
 * printed as it happens and recorded in run history. `--json` emits the same
 * steps as structured records rather than lines.
 */
/**
 * The most recent run that saved a harness session, or null.
 *
 * `--continue` needs a session id, and the honest source is history: the run
 * may have finished in an earlier process. Newest first, because "continue"
 * means the thing you were just doing.
 */
function lastResumableRun() {
  try {
    const { entries } = readHistory({ limit: 100 });
    return entries.find((e) => typeof e.sessionId === 'string' && e.sessionId !== '') || null;
  } catch {
    return null;
  }
}

async function runAgentPrompt(prompt, playbookId, classification, flags) {
  const mode = flags.apply ? 'apply' : 'read-only';
  const resuming = flags.continue ? lastResumableRun() : null;
  if (flags.continue && !resuming) {
    const err = new Error(
      'Nothing to continue: no recorded run has a saved session. Sessions are written from now on, so this works for runs started after the upgrade.'
    );
    if (flags.json) emitJson({ ok: false, error: err.message });
    else console.error(`[!] ${err.message}`);
    process.exitCode = 1;
    return null;
  }
  const budget = flags.maxTurns ?? (resuming ? continuationBudget(resuming.maxTurns) : DEFAULT_MAX_TURNS);
  if (!flags.json) {
    console.log(`[>] Agentic run (${mode}, max ${budget} turns) in ${flags.project ? process.cwd() : 'the zstack workspace'}`);
    if (resuming) {
      console.log(`    Continuing run ${resuming.id}, which used ${resuming.turns ?? 'its'} turns before stopping.`);
    }
    if (!flags.apply) {
      console.log('    Mutating tool calls will be declined. Pass --apply to let the agent change files.');
    }
  }

  const started = Date.now();
  const request = normalizeStartRequest({ ...agentOptions(prompt, playbookId, flags),
    maxTurns: budget, continuationOf: resuming?.id });
  const live = createLiveRun({ id: newRunId(), prompt, ...request });
  live.request = request;
  live.historySteps = [];
  const checkpoint = () => checkpointHistory({ ...historyRecordFor(request, {}, live),
    ok: false, durationMs: Date.now() - started, errorKind: 'interrupted',
    error: 'The CLI process stopped before this run finished.' });
  checkpoint();
  const steps = [];
  // Coalesces streamed text deltas into readable blocks; `push` and `flush`
  // keep the live view identical to what run history records.
  const renderer = createProgressRenderer({
    write: (line) => console.log(line)
  });
  const onEvent = (event) => {
    steps.push(event);
    applyLiveEvent(live, event);
    collectHistoryEvent(live, event);
    checkpoint();
    if (flags.json) {
      // One record per line on stderr, keeping stdout parseable.
      console.error(JSON.stringify({ zstack: 'step', ...event }));
      return;
    }
    renderer.push(event);
  };
  try {
    // A run that reaches its budget is extended rather than stopped, here as
    // well as in the browser: a task cut off mid-work costs the same wherever
    // it was started, and the reader chose a size of job rather than a place to
    // be interrupted.
    const outcome = await runWithExtensions({
      maxTurns: budget,
      resume: resuming?.sessionId ?? null,
      call: ({ maxTurns, resume }) => z.agent({
        ...agentOptions(prompt, playbookId, flags),
        maxTurns,
        resume,
        onEvent
      }),
      onExtend: ({ to, grant }) => {
        live.turnOffset = live.turns;
        live.tokenOffset = live.tokens || 0;
        if (!flags.json) {
          console.log(`[>] Out of turns. Extending this run with ${grant} more (${to} total).`);
        } else {
          console.error(JSON.stringify({ zstack: 'extended', maxTurns: to, granted: grant }));
        }
      }
    });
    const res = outcome.result;
    if (!flags.json) renderer.flush();

    let prUrl = null;
    if (flags.autoPr && res.ok && flags.apply) {
      const hasChanges = (res.fileChanges && res.fileChanges.length > 0) || (res.changes && res.changes.length > 0);
      if (hasChanges) {
        try {
          const workspaceDir = res.workspaceDir || process.cwd();
          const branchSlug = (prompt || 'feature')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .slice(0, 24)
            .replace(/^-+|-+$/g, '') || 'feature';
          const branchName = `zstack/${branchSlug}-${Date.now().toString(36)}`;
          await commitAndPushBranch(workspaceDir, {
            branch: branchName,
            message: `zstack: ${prompt.slice(0, 50)}`
          });
          const prDoc = await createPullRequest({
            dir: workspaceDir,
            title: `zstack: ${prompt.slice(0, 50)}`,
            body: `## Summary\n${prompt}\n\n## Changes\n${(res.fileChanges || []).map((f) => `- \`${f.path || f}\``).join('\n')}`,
            head: branchName
          });
          prUrl = prDoc.url;
          if (!flags.json) {
            console.log(`[✓] Pull request opened: ${prUrl}`);
          }
        } catch (err) {
          if (!flags.json) {
            console.warn(`[!] Auto-PR failed: ${err.message}`);
          }
        }
      } else if (!flags.json) {
        console.log('[!] Auto-PR skipped: no file changes were made.');
      }
    }

    recordRun({
      ...historyRecordFor(request, res, live),
      id: live.id,
      command: 'agent',
      playbook: res.playbook,
      role: res.role,
      model: res.model,
      durationMs: res.durationMs,
      usage: res.usage,
      contextEstimate: null,
      promptChars: prompt.length,
      promptPreview: prompt,
      files: flags.files || [],
      ok: res.ok,
      applied: res.applied,
      policy: flags.apply ? 'apply' : 'read-only',
      autoPr: !!flags.autoPr,
      prUrl,
      // Cumulative across every segment, not the last one's count. Reporting
      // the final segment's turns would describe a 175-turn run as its last 100.
      turns: outcome.used,
      // The budget, whether it ran out, and the session that can continue it.
      // Without these in history, `--continue` would have nothing to resume and
      // a run that stopped early would be indistinguishable from one that
      // finished.
      maxTurns: outcome.granted,
      turnLimitReached: res.turnLimitReached || undefined,
      extensions: outcome.extensions.length || undefined,
      sessionId: res.sessionId ?? null,
      continuationOf: resuming?.id ?? null,
      toolCalls: res.toolCalls,
      failedTools: res.failedTools,
      declinedTools: res.declinedTools,
      workspace: res.workspaceDir,
      changes: res.changes,
      fileChanges: res.fileChanges,
      steps: res.steps
    });

    if (flags.json) {
      emitJson({
        ok: res.ok,
        content: res.content,
        model: res.model,
        role: res.role,
        playbook: res.playbook,
        principles: res.principles,
        classification: res.classification,
        applied: res.applied,
        autoPr: !!flags.autoPr,
        prUrl: prUrl ?? undefined,
        workspace: res.workspaceDir,
        turns: outcome.used,
        maxTurns: outcome.granted,
        extensions: outcome.extensions.length,
        turnLimitReached: res.turnLimitReached,
        toolCalls: res.toolCalls,
        failedTools: res.failedTools,
        declinedTools: res.declinedTools,
        approvals: res.approvals,
        changes: res.changes,
        fileChanges: res.fileChanges,
        gitStatus: res.applied ? observeGitStatus(res.workspaceDir) : null,
        steps: res.steps,
        usage: res.usage,
        durationMs: res.durationMs,
        sessionId: res.sessionId,
        harness: res.harness
      });
      return res;
    }

    // The summary counts the whole run, including the segments an extension
    // added, so the numbers printed match the record that was just written.
    reportProgression({ ...res, turns: outcome.used, maxTurns: outcome.granted }, Date.now() - started, mode);
    if (res.content) {
      console.log(`\n${res.content}`);
    } else {
      // An empty answer is ambiguous on its own, so say which case this is
      // rather than printing a blank line and letting the user guess.
      const why = explainEmptyContent(res);
      if (why) console.log(`\n[!] ${why}`);
    }
    return res;
  } catch (err) {
    recordRun({
      id: live.id,
      command: 'agent',
      ...historyRecordFor(request, { ok: false }, live),
      error: err?.message || String(err),
      playbook: playbookId,
      role: classification.role,
      model: null,
      durationMs: Date.now() - started,
      usage: null,
      contextEstimate: null,
      promptChars: prompt.length,
      promptPreview: prompt,
      files: flags.files || [],
      ok: false,
      errorKind: err?.kind || 'error',
      exitCode: exitCodeFor(err)
    });
    if (err?.kind === 'harness-missing') {
      fail(
        `${err.message}\n    Install it with: npm i -g modelhitch`,
        EXIT.FAIL,
        flags
      );
    }
    failWith(err, flags, EXIT.FAIL, '[!] Agent run failed');
  }
}

/** Closing summary for an agentic run. */
function reportProgression(res, wallMs, mode) {
  const parts = [
    `${res.turns} turn${res.turns === 1 ? '' : 's'}`,
    `${res.toolCalls} tool call${res.toolCalls === 1 ? '' : 's'}`
  ];
  if (res.declinedTools) parts.push(`${res.declinedTools} declined`);
  if (res.failedTools) parts.push(`${res.failedTools} failed`);
  if (res.usage?.total_tokens) parts.push(`${res.usage.total_tokens} tokens`);
  parts.push(`${wallMs}ms`);

  console.log(`\n[${res.ok ? '✓' : '!'}] Model: ${res.model || 'default'} | Role: ${res.role} | ${mode} (${parts.join(' | ')})`);

  if (res.fileChanges?.length) {
    const unique = [...new Set(res.fileChanges.map((c) => c.path))];
    console.log(`[✓] Changed ${unique.length} file${unique.length === 1 ? '' : 's'}:`);
    for (const path of unique) {
      const tools = [...new Set(res.fileChanges.filter((c) => c.path === path).map((c) => c.tool))];
      console.log(`    ~ ${path}  (${tools.join(', ')})`);
    }
    if (res.changes?.length) {
      const added = res.changes.reduce((n, c) => n + (c.added || 0), 0);
      const removed = res.changes.reduce((n, c) => n + (c.removed || 0), 0);
      console.log(`    diff: +${added}/-${removed} across ${res.changes.length} mutation${res.changes.length === 1 ? '' : 's'}`);
    }
  }

  // Git is the artifact that does not care which tool wrote the bytes, so it
  // catches writes that arrived through a shell command.
  if (res.applied) {
    const git = observeGitStatus(res.workspaceDir);
    if (git && git.count > 0) {
      if (!res.fileChanges?.length) {
        console.log(`[✓] Workspace changed (${git.count} path${git.count === 1 ? '' : 's'} per git):`);
      } else {
        console.log(`[✓] git status: ${git.count} path${git.count === 1 ? '' : 's'} changed`);
      }
      for (const entry of git.entries.slice(0, 20)) {
        console.log(`    ${entry.status.padEnd(2)} ${entry.path}`);
      }
      if (git.entries.length > 20) console.log(`    … and ${git.entries.length - 20} more`);
    } else if (git && git.count === 0 && !res.fileChanges?.length) {
      console.log('[·] git status is clean: no file changes.');
    } else if (!git && !res.fileChanges?.length) {
      // Not a git repo and no tool-attributed writes: say what is actually
      // known rather than claiming nothing changed.
      console.log('[·] No file changes attributed to a writer tool, and this workspace is not a git repository, so changes made through shell commands cannot be confirmed either way.');
    }
  } else if (res.changes?.length) {
    const added = res.changes.reduce((n, c) => n + (c.added || 0), 0);
    const removed = res.changes.reduce((n, c) => n + (c.removed || 0), 0);
    console.log(`[!] ${res.changes.length} mutation${res.changes.length === 1 ? '' : 's'} (+${added}/-${removed}) seen in a read-only run.`);
  }

  if (res.declinedTools && !res.applied) {
    console.log(`[!] ${res.declinedTools} mutating call${res.declinedTools === 1 ? '' : 's'} declined. Re-run with --apply to allow changes.`);
  }
  if (res.malformedEvents) {
    console.log(`[!] ${res.malformedEvents} unreadable event line${res.malformedEvents === 1 ? '' : 's'} from the harness.`);
  }
  if (!res.ok) {
    console.log(`[!] The harness exited ${res.exitCode}. The work above may be incomplete.`);
  }
}

/**
 * Shared one-shot execution used by `prompt`/`run`, bare prompts, and the
 * interactive shell. Records exactly one history line per invocation.
 *
 * An agentic invocation (`--agent`, `--apply`, `--project`) runs the tool loop
 * and streams its progression; everything else is a single completion.
 */
async function runOneShotPrompt(prompt, flags, asker) {
  const { playbookId, classification, guided } = await resolveGuidedPlaybook(prompt, flags, asker);
  if (!flags.json) {
    console.log(`[>] Task classified as [${classification.type}]${guided ? ` (guided selection: ${playbookId})` : ''} (playbook: playbooks/${playbookId}.md)`);
    console.log(`    Principles: ${(flags.playbook ? z.classifyPrompt(prompt).principles : classification.principles).join(', ')}`);
  } else {
    console.error(`Task classified as [${playbookId}]${guided ? ' (guided, top candidate)' : ''}`);
  }

  if (isAgentic(flags)) {
    return await runAgentPrompt(prompt, playbookId, classification, flags);
  }

  try {
    const res = await z.task(taskOptions(prompt, playbookId, flags));
    recordRun({
      command: 'prompt',
      playbook: res.playbook,
      role: res.role,
      model: res.model,
      durationMs: res.durationMs,
      usage: res.usage,
      contextEstimate: res.context?.estimatedTokens ?? null,
      promptChars: prompt.length,
      promptPreview: prompt,
      files: flags.files || [],
      ok: true
    });
    if (flags.json) {
      emitJson({
        ok: true, content: res.content, model: res.model, role: res.role,
        playbook: res.playbook, principles: res.principles,
        classification: res.classification ?? null, context: res.context ?? null,
        usage: res.usage, durationMs: res.durationMs
      });
      return res;
    }
    reportContext(res.context, flags);
    console.log(`[✓] Model: ${res.model} | Role: ${res.role} (${res.durationMs}ms | ${res.usage.total_tokens} tokens)\n`);
    console.log(res.content);
    return res;
  } catch (err) {
    recordRun({
      command: 'prompt',
      playbook: playbookId,
      role: classification.role,
      model: null,
      durationMs: null,
      usage: null,
      contextEstimate: null,
      promptChars: prompt.length,
      promptPreview: prompt,
      files: flags.files || [],
      ok: false,
      errorKind: err?.kind || 'error',
      exitCode: exitCodeFor(err)
    });
    throw err;
  }
}

async function handleOneShotPrompt(args) {
  const { flags, text } = parseArgs(args);
  const prompt = text;
  if (!prompt) {
    if (flags.json) jsonError('Missing prompt. Usage: zstack "<prompt>"', EXIT.USAGE);
    await printHelp();
    return;
  }

  try {
    await runOneShotPrompt(prompt, flags);
  } catch (err) {
    failWith(err, flags, EXIT.FAIL, '[!] Execution failed');
  }
}

async function handlePanel(args) {
  const { flags, text } = parseArgs(args);
  if (!text) {
    fail('Error: panel review requires a prompt or architecture topic.', EXIT.USAGE, flags);
  }

  if (!flags.json) console.log(`[>] Dispatching adversarial panel review across multi-family models via ModelHitch...\n`);
  else console.error(`Dispatching adversarial panel review...`);
  try {
    const results = await z.panel(text);
    const failed = results.filter(r => !r.ok).length;
    recordRun({
      command: 'panel',
      playbook: null,
      role: null,
      model: null,
      durationMs: Math.max(0, ...results.map(r => r.durationMs || 0)),
      usage: null,
      contextEstimate: null,
      promptChars: text.length,
      promptPreview: text,
      files: [],
      ok: failed === 0,
      errorKind: failed > 0 ? 'partial' : null,
      exitCode: failed > 0 ? EXIT.PARTIAL : EXIT.OK
    });
    if (flags.json) {
      emitJson({ ok: failed === 0, prompt: text, results });
      process.exit(failed === 0 ? EXIT.OK : EXIT.PARTIAL);
    }
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
    if (failed > 0) process.exit(EXIT.PARTIAL);
  } catch (err) {
    recordRun({
      command: 'panel',
      playbook: null,
      role: null,
      model: null,
      durationMs: null,
      usage: null,
      contextEstimate: null,
      promptChars: text.length,
      promptPreview: text,
      files: [],
      ok: false,
      errorKind: err?.kind || 'error',
      exitCode: exitCodeFor(err)
    });
    failWith(err, flags, EXIT.FAIL, '[!] Panel failed');
  }
}

async function handleBudget(args) {
  const { flags, positional } = parseArgs(args);
  if (positional[0] === 'help' || positional[0] === '--help' || positional[0] === '-h') {
    if (flags.json) {
      emitJson({ ok: true, command: 'budget', tiers: BUDGET_TIERS, sources: BUDGET_SOURCES, lanes: LANES, stored: getStoredBudget() });
      return;
    }
    console.log(`
zstack budget — preview and confirm model budget mapping (confirmation required before apply)

Usage:
  zstack budget                          Show current budget + preview mapping
  zstack budget low-med                  Preview Low-Med tier (current source and lane)
  zstack budget high --source config     Preview High tier, Option A (ModelHitch config only)
  zstack budget max --source catalog --confirm   Apply Max tier, Option B without prompt
  zstack budget med-high --go            Preview the Med-High tier on the OpenCode Go lane
  zstack budget med-high --hf            Preview the Med-High tier on the HuggingFace lane

Tiers: low-med | med-high | high | max
Sources: config (A: config-pinned models) | catalog (B: provider-aligned presets)
Lanes:   auto (default) | zen (OpenCode Zen) | go (OpenCode Go) | hitch (ModelHitch routing)
         hf (HuggingFace router, filtered for quality before any role is pinned)
  Shortcuts: --zen, --go, --hitch, --hf set the lane without --lane.
  See what the HuggingFace filter admitted and rejected with: zstack hf
`);
    return;
  }
  const stored = getStoredBudget();
  const tierArg = (positional[0] || flags.tier || stored.tier || 'med-high').toLowerCase();
  const sourceArg = (flags.source || stored.source || 'catalog').toLowerCase();
  const laneArg = normalizeLane(flags.lane || stored.lane);
  if (!isKnownLane(flags.lane)) {
    fail(`Error: unknown lane "${flags.lane}". Valid lanes: ${Object.keys(LANES).join(', ')}`, EXIT.USAGE, flags);
  }

  if (!BUDGET_TIERS[tierArg]) {
    fail(`Error: unknown budget tier "${tierArg}". Valid tiers: ${Object.keys(BUDGET_TIERS).join(', ')}`, EXIT.USAGE, flags);
  }
  if (sourceArg !== 'config' && sourceArg !== 'catalog') {
    fail(`Error: unknown budget source "${sourceArg}". Valid sources: config, catalog`, EXIT.USAGE, flags);
  }

  let state;
  try {
    state = await fetchModelHitchState(z.baseUrl);
  } catch (err) {
    const message = `Cannot reach ModelHitch at ${z.baseUrl}: ${err.message}`;
    if (flags.json) jsonError(message, EXIT.GATEWAY, { baseUrl: z.baseUrl });
    console.error(`[!] ${message}`);
    process.exit(EXIT.GATEWAY);
  }

  if (flags.json && !(flags.confirm || flags.yes || flags.apply)) {
    // --json without --confirm previews only: no interactive prompt, nothing applied.
    const { resolveBudgetMapping } = await import('../src/budget.mjs');
    const preview = resolveBudgetMapping({ tier: tierArg, source: sourceArg, lane: laneArg, state });
    emitJson({ ok: true, applied: false, preview });
    return;
  }

  if (!flags.json) {
    console.log('\n=== zstack Model Budget Tiers ===');
    for (const [id, info] of Object.entries(BUDGET_TIERS)) {
      const marker = id === tierArg ? '>' : ' ';
      console.log(` ${marker} ${id.padEnd(10)} ${info.name.padEnd(10)} ${info.profile}`);
      console.log(`              ${info.description}`);
    }
    console.log('\nModel selection sources:');
    for (const [id, desc] of Object.entries(BUDGET_SOURCES)) {
      const marker = id === sourceArg ? '>' : ' ';
      console.log(` ${marker} ${id.padEnd(10)} ${desc}`);
    }
    console.log('\nProvider lanes:');
    for (const [id, info] of Object.entries(LANES)) {
      const marker = id === laneArg ? '>' : ' ';
      console.log(` ${marker} ${id.padEnd(10)} ${info.name.padEnd(18)} ${info.description}`);
    }
  } else {
    console.error(`Previewing budget tier ${tierArg} (source ${sourceArg}, lane ${laneArg})...`);
  }

  const result = await promptAndSetBudget({
    tier: tierArg,
    source: sourceArg,
    lane: laneArg,
    state,
    project: flags.project,
    confirm: flags.confirm || flags.yes || flags.apply
  });
  if (flags.json) {
    emitJson({ ok: true, applied: result.applied, budget: result.budget, rulePath: result.rulePath ?? null });
  }
}

const HF_HELP = `
zstack hf — what the HuggingFace lane's filter does before any role is pinned

HuggingFace's router serves a catalogue anyone can publish to, so the lane does
not pin roles from a hand-written list. It filters first: capability gates drop
models that cannot do the work (no tool calling, too small a context window, no
live provider), curation gates drop the rest (non-chat models, base
checkpoints, quantized and dated duplicates of a model already listed, the tiny
tail), and the survivors are ranked per role. Every decision is listed below
with the rule that made it.

Usage:
  zstack hf                          Filter report for the stored budget tier
  zstack hf --tier max               Report as the Max tier would filter it
  zstack hf --all                    List every rejected model, not just the counts
  zstack hf --json                   Single JSON document (rejections included)
  zstack hf --refresh                Refetch capability metadata instead of the cache

Nothing is written and no role is changed here: this command only reports. Pin
the lane with \`zstack budget --lane hf --confirm\` or run once with \`--hf\`.
`;

/**
 * Report the HuggingFace lane's filter decision.
 *
 * The lane pins models that a reader did not choose, so the filter has to be
 * inspectable rather than trusted: this prints what survived, what did not,
 * and which rule decided each. It reads state only and never writes, so it is
 * safe to run against a live gateway at any time.
 */
async function handleHf(args) {
  const { flags, positional } = parseArgs(args);
  // Matches `handleBudget`: `--help` reaches a handler as a positional, since
  // the parser only knows the flags it was taught.
  if (positional[0] === 'help' || positional[0] === '--help' || positional[0] === '-h') {
    console.log(HF_HELP);
    return;
  }

  const stored = getStoredBudget();
  const tier = (flags.tier || stored.tier || 'med-high').toLowerCase();
  if (!BUDGET_TIERS[tier]) {
    fail(`Error: unknown budget tier "${tier}". Valid tiers: ${Object.keys(BUDGET_TIERS).join(', ')}`, EXIT.USAGE, flags);
  }

  let state;
  try {
    state = await fetchModelHitchState(z.baseUrl, { refreshHfCapabilities: !!flags.refresh });
  } catch (err) {
    const message = `Cannot reach ModelHitch at ${z.baseUrl}: ${err.message}`;
    if (flags.json) jsonError(message, EXIT.GATEWAY, { baseUrl: z.baseUrl });
    console.error(`[!] ${message}`);
    process.exit(EXIT.GATEWAY);
  }

  const hfIds = state.models.map(m => m.id).filter(isHuggingFaceModel);
  const keyPresent = hasHuggingFaceKey(state.keys);
  const lane = resolveHuggingFaceLane(state.models.map(m => m.id), {
    tier,
    capabilities: state.hfCapabilities?.models || null,
    capabilitySource: state.hfCapabilities?.source || 'unavailable'
  });
  const report = describeHuggingFaceFilter(lane.report);

  // Nothing to report on is a failure to answer the question that was asked, in
  // both output modes, so the exit code says so either way rather than
  // depending on whether the caller asked for JSON.
  if (hfIds.length === 0) {
    const message = keyPresent
      ? 'The gateway serves no HuggingFace models even though a key is present, so the lane cannot resolve.'
      : 'The gateway serves no HuggingFace models. Set HF_TOKEN in ModelHitch\'s config, then retry.';
    if (flags.json) {
      emitJson({
        ok: false,
        error: message,
        command: 'hf',
        tier,
        keyPresent,
        considered: 0,
        lane: { applied: false, note: lane.note },
        filter: report
      });
    } else {
      console.error(`[!] ${message}`);
    }
    // Assign the code and return rather than calling process.exit: the gateway
    // connection is still open, and tearing the process down under it trips a
    // libuv assertion on Windows (UV_HANDLE_CLOSING) instead of exiting.
    process.exitCode = EXIT.FAIL;
    return;
  }

  if (flags.json) {
    emitJson({
      ok: true,
      command: 'hf',
      tier,
      keyPresent,
      considered: report?.considered ?? 0,
      lane: {
        applied: lane.applied,
        coder: lane.coder,
        fast: lane.fast,
        architect: lane.architect,
        reasoner: lane.reasoner,
        panel: lane.panel,
        note: lane.note
      },
      filter: report
    });
    return;
  }

  console.log(`\n=== HuggingFace lane filter (tier: ${tier}, floor: ${report.sizeFloor}B) ===`);
  console.log(`Catalogue:   ${report.considered} HuggingFace models served by the gateway`);
  console.log(`Capability:  ${report.capabilitySource === 'unavailable'
    ? 'unavailable, so curation rules alone decided (rerun with --refresh if the network was down)'
    : `live metadata via ${report.capabilitySource}, gating tool calling and context`}`);
  console.log(`Admitted:    ${report.admitted} models`);
  console.log(`Rejected:    ${report.rejected} models`);

  console.log('\nRejections by rule:');
  for (const [gate, count] of Object.entries(report.rejectedByGate).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(3)}  ${gate}`);
  }

  if (flags.all) {
    console.log('\nEvery rejection:');
    for (const r of report.exclusions) {
      console.log(`  ${r.id}`);
      console.log(`      ${r.gate}: ${r.reason}`);
    }
  }

  console.log('\nPinned roles (what the lane would actually use):');
  const picks = [
    ['coder (feature, bug-fix, explorer, investigators, reflect tooling)', lane.coder],
    ['fast exploration', lane.fast],
    ['architect (judgment, explainer, synthesizer)', lane.architect],
    ['deep reasoning', lane.reasoner]
  ];
  for (const [role, model] of picks) {
    console.log(`  ${role}`);
    console.log(`      ${model ?? '(none: the lane did not resolve)'}`);
  }
  console.log(`  panel (adversarial reviewers, distinct publishers)`);
  for (const m of lane.panel) console.log(`      ${m}`);
  if (lane.note) console.log(`\n[!] ${lane.note}`);

  console.log('\nTop admitted models by score:');
  for (const m of report.models.slice(0, 10)) {
    const size = m.effectiveParamsB != null ? `${m.effectiveParamsB}B` : 'unrated';
    const ctx = m.contextLength != null ? `${Math.round(m.contextLength / 1024)}k ctx` : 'ctx unknown';
    const tools = m.supportsTools === true ? 'tools' : (m.supportsTools === false ? 'NO TOOLS' : 'tools unknown');
    console.log(`  ${String(m.score.overall).padStart(4)}  ${m.id}`);
    console.log(`        ${size}, ${ctx}, ${tools}, coder ${m.score.coder}, reasoner ${m.score.reasoner}`);
  }
  console.log(`\nPin this lane with: zstack budget --lane hf --confirm   (or one run: zstack --hf "<task>")`);
}

function readDiffInput(args) {
  const { flags, text } = parseArgs(args);
  if (flags.file) {
    if (!existsSync(flags.file)) {
      fail(`Error: diff file not found: ${flags.file}`, EXIT.USAGE, flags);
    }
    try {
      return { diff: readFileSync(flags.file, 'utf8'), flags };
    } catch (err) {
      fail(`Error: cannot read diff file: ${err.message}`, EXIT.FAIL, flags);
    }
  }
  if (!text) {
    fail('Error: grade requires a diff. Usage: zstack grade --file <diff.patch> [--json] or zstack grade "<diff text>"', EXIT.USAGE, flags);
  }
  return { diff: text, flags };
}

async function handleGrade(args) {
  const { diff, flags } = readDiffInput(args);
  if (!flags.json) console.log('[>] Grading diff against zstack principles...\n');
  else console.error('Grading diff against zstack principles...');
  try {
    const result = await gradeDiff(diff, { baseUrl: z.baseUrl, rootDir: z.rootDir });
    if (flags.json) {
      emitJson({
        ok: !result.parseError,
        model: result.model,
        chunked: result.chunked,
        principles: result.principles,
        verdicts: result.verdicts,
        parseError: result.parseError ?? null
      });
      return;
    }
    if (result.parseError) {
      console.error(`[!] Model response was not valid JSON (retried once): ${result.parseError}`);
      console.error('    No verdicts fabricated. Raw response follows:\n');
      console.log(result.raw);
      process.exit(EXIT.FAIL);
    }
    console.log(formatVerdictTable(result.verdicts));
    if (result.chunked) console.log('\n    (diff was chunked by file hunk; verdicts merge across chunks)');
    console.log('\n--- verdicts (JSON) ---');
    console.log(JSON.stringify(result.verdicts, null, 2));
  } catch (err) {
    if (err.message.startsWith('Empty diff')) {
      fail(`[!] Grade failed: ${err.message}`, EXIT.USAGE, flags);
    }
    failWith(err, flags, EXIT.FAIL, '[!] Grade failed');
  }
}

async function readAllStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function printTriage(result, flags) {
  if (flags.json) {
    emitJson({
      ok: true,
      heuristicOnly: result.heuristicOnly,
      notice: result.notice,
      notes: result.notes || [],
      candidates: result.candidates
    });
    return;
  }
  if (result.heuristicOnly && result.notice) console.log(`${result.notice}\n`);
  console.log('Ranked playbooks:');
  result.candidates.forEach((c, i) => {
    console.log(`  ${i + 1}. ${c.playbook} (confidence ${c.confidence}, ${c.reason})`);
    console.log(`     trigger: ${c.trigger}`);
    for (const cmd of c.nextCommands || []) console.log(`     next: ${cmd}`);
  });
  for (const n of result.notes || []) console.log(`    note: ${n}`);
  console.log('');
}

async function handleTriage(args) {
  const { flags, text } = parseArgs(args);
  let input = null;
  if (flags.file) {
    try {
      input = readFileSync(flags.file);
    } catch (err) {
      fail(`Error: cannot read triage file ${flags.file}: ${err.message}`, EXIT.USAGE, flags);
    }
  } else if (!process.stdin.isTTY) {
    input = await readAllStdin();
  } else if (text) {
    input = text;
  } else {
    fail('Error: triage requires input. Usage: zstack triage --file <log> [--json] or pipe failure output on stdin', EXIT.USAGE, flags);
  }
  if (!String(input).trim()) {
    fail('Error: triage input is empty', EXIT.USAGE, flags);
  }
  if (!flags.json) console.log('[>] Triaging failure output...\n');
  else console.error('Triaging failure output...');
  try {
    const result = await triageFailure({
      input,
      live: flags.live !== false,
      baseUrl: z.baseUrl,
      rootDir: z.rootDir,
      timeoutMs: z.timeoutMs,
      budgetTokens: flags.contextBudget,
      noPrune: flags.noPrune || undefined
    });
    printTriage(result, flags);
  } catch (err) {
    if (/Empty triage input|exceeds the budget/.test(err.message)) {
      fail(`[!] Triage failed: ${err.message}`, /Empty triage input/.test(err.message) ? EXIT.USAGE : EXIT.FAIL, flags);
    }
    failWith(err, flags, EXIT.FAIL, '[!] Triage failed');
  }
}

async function handleExplore(args) {
  const { flags, text } = parseArgs(args);
  if (!text) {
    fail('Error: explore requires a query. Usage: zstack explore "<query>" [--paths src,tests] [--json]', EXIT.USAGE, flags);
  }
  if (flags.maxFilesError !== undefined) {
    fail(`Error: --max-files expects a positive integer (got "${flags.maxFilesError}").`, EXIT.USAGE, flags);
  }
  const ctx = contextFlags(flags);
  const paths = flags.paths && flags.paths.length > 0 ? flags.paths : ['.'];
  if (!flags.json) console.log(`[>] Offloading context search for: ${text}\n`);
  else console.error(`Offloading context search for: ${text}`);
  try {
    const result = await runContextOffload({
      query: text,
      paths,
      maxFiles: flags.maxFiles ?? 40,
      budgetTokens: ctx.contextBudget ?? 4000,
      baseUrl: z.baseUrl,
      timeoutMs: z.timeoutMs,
      rootDir: z.rootDir
    });
    if (flags.json) {
      emitJson({
        ok: result.ok,
        answer: result.answer,
        findings: result.findings || [],
        uncovered: result.uncovered || [],
        filesScanned: result.filesScanned,
        filesAttached: result.filesAttached,
        estimatedTokens: result.estimatedTokens,
        omitted: result.omitted || [],
        model: result.model,
        role: result.role,
        durationMs: result.durationMs,
        error: result.error || null
      });
      if (result.ok === false) process.exit(EXIT.FAIL);
      return;
    }
    console.log(formatOffloadReport(result));
    console.log(`\nScanned ${result.filesScanned} files · attached ${result.filesAttached} · ~${result.estimatedTokens} tokens`);
    if (result.ok === false) process.exit(EXIT.FAIL);
  } catch (err) {
    failWith(err, flags, EXIT.FAIL, '[!] Explore failed');
  }
}

function printHistoryEntry(e, options = {}) {
  const status = e.ok ? 'ok' : `FAILED(${e.exitCode ?? 1}${e.errorKind ? ':' + e.errorKind : ''})`;
  const model = e.model ? ` | ${e.model}` : '';
  console.log(`  ${e.ts}  [${status}] ${e.command}${e.playbook ? ':' + e.playbook : ''}${model}`);
  console.log(`    prompt (${e.promptChars ?? '?'} chars): ${(e.promptPreview || '').replace(/\s+/g, ' ').slice(0, 100)}`);

  if (e.agentic) {
    const parts = [];
    if (e.turns != null) parts.push(`${e.turns} turns`);
    if (e.toolCalls != null) parts.push(`${e.toolCalls} tool calls`);
    if (e.declinedTools) parts.push(`${e.declinedTools} declined`);
    if (e.failedTools) parts.push(`${e.failedTools} failed`);
    parts.push(e.applied ? 'applied' : 'read-only');
    if (e.workspace) parts.push(e.workspace);
    console.log(`    agent: ${parts.join(' | ')}`);

    const paths = [...new Set((e.fileChanges || []).map((c) => c.path))];
    if (paths.length > 0) {
      console.log(`    changed ${paths.length} file${paths.length === 1 ? '' : 's'}: ${paths.join(', ')}`);
    }
  }

  if (options.steps && Array.isArray(e.steps) && e.steps.length > 0) {
    console.log('    steps:');
    for (const step of e.steps) {
      const line = formatStoredStep(step);
      if (line) console.log(`      ${line}`);
    }
    if (e.stepsTruncated) console.log('      … further steps not recorded');
  }
}

/**
 * One stored step as a line.
 *
 * History stores a compact step shape, not the raw event, so this renders that
 * shape rather than reusing `formatEventLine` and silently printing blanks.
 */
function formatStoredStep(step) {
  switch (step.kind) {
    case 'start':
      return `run started: ${step.model || 'default'}${step.workspace ? ` in ${step.workspace}` : ''}`;
    case 'turn':
      return `turn ${step.turn}${step.tokens ? ` (${step.tokens} tokens)` : ''}`;
    case 'tool': {
      const detail = [step.outcome, step.durationMs != null ? `${step.durationMs}ms` : null].filter(Boolean).join(', ');
      const mark = step.outcome === 'ok' || step.outcome === 'dry-run' ? '·' : '!';
      return `${mark} turn ${step.turn ?? '?'}: ${step.name}${step.target ? ` ${step.target}` : ''}  [${detail}]`;
    }
    case 'approval':
      return `! approval ${step.tool}: ${step.decision}${step.risk ? ` (${step.risk})` : ''}`;
    default:
      return null;
  }
}

async function handleHistory(args) {
  const { flags } = parseArgs(args);
  if (flags.limitError !== undefined) {
    fail(`Error: --limit expects a positive integer (got "${flags.limitError}").`, EXIT.USAGE, flags);
  }
  if (flags.rerun) {
    const entry = lastEntry();
    if (!entry) {
      fail('Error: no history entries to rerun.', EXIT.USAGE, flags);
    }
    if (needsRerunConfirm(entry) && !(flags.yes || flags.confirm)) {
      fail(
        `Warning: the recorded prompt preview may be incomplete (${entry.promptChars} chars stored as ${HISTORY_PREVIEW_CHARS}). Re-run with --yes to confirm.`,
        EXIT.USAGE,
        flags
      );
    }
    if (!flags.json) console.log(`[>] Re-running last invocation [${entry.command}${entry.playbook ? ':' + entry.playbook : ''}]...`);
    else console.error('Re-running last invocation...');
    try {
      if (entry.command === 'panel') {
        await handlePanel([entry.promptPreview, ...(flags.json ? ['--json'] : [])]);
      } else if (entry.command === 'task') {
        await handleTask([entry.playbook || 'feature', entry.promptPreview, ...(flags.json ? ['--json'] : [])]);
      } else {
        await runOneShotPrompt(entry.promptPreview, { ...flags, playbook: entry.playbook || undefined, role: entry.role || undefined, model: entry.model || undefined, files: entry.files || [] });
      }
    } catch (err) {
      failWith(err, flags, EXIT.FAIL, '[!] Rerun failed');
    }
    return;
  }
  const limit = flags.last ? 1 : (flags.limit ?? 20);
  const { entries, skipped, total } = readHistory({ limit });
  if (flags.json) {
    emitJson({ ok: true, total, skipped, entries });
    return;
  }
  if (entries.length === 0) {
    console.log('No run history yet.');
    return;
  }
  // `--steps` expands the progression of each run: what the agent actually did,
  // which for an agentic run is the part the final message does not contain.
  const showSteps = !!flags.steps;
  console.log('\n=== zstack Run History (newest first) ===\n');
  for (const e of entries) printHistoryEntry(e, { steps: showSteps });
  console.log(`\nShowing ${entries.length} of ${total} runs${skipped > 0 ? ` (${skipped} malformed lines skipped)` : ''}.`);
  if (!showSteps && entries.some((e) => e.agentic)) {
    console.log('Add --steps to expand what each agentic run did.');
  }
  console.log('');
}

/**
 * Run the local UI server until interrupted.
 *
 * The process stays in the foreground on purpose. A backgrounded server that
 * nobody is watching is one you forget about, and this one can start agent runs
 * that change files, so it should be as visible as any other long-running
 * command. Ctrl-C stops it.
 */
async function handleServe(args) {
  const { flags } = parseArgs(args);
  if (flags.portError !== undefined) {
    fail(`Error: --port expects an integer from 0 to 65535 (got "${flags.portError}").`, EXIT.USAGE, flags);
  }
  const host = flags.host || DEFAULT_HOST;
  const port = flags.port ?? DEFAULT_PORT;
  const requireAuth = flags.requireAuth || envTruthy(process.env.ZSTACK_REQUIRE_AUTH);

  if (!isLoopback(host)) {
    console.error(`[!] Binding ${host} exposes this server beyond this machine.`);
    console.error('    It starts agent runs and executes shell commands. Anyone who can reach');
    console.error('    this port can change files on this machine. Prefer the default 127.0.0.1.');
    if (!requireAuth && !process.env.ZSTACK_API_TOKEN) {
      console.error('    This bind has no credential requirement: pass --require-auth and mint a');
      console.error('    key with `zstack keys new "<name>"` so the port is not open to the network.');
    }
  }

  let started;
  try {
    started = await startServer({ host, port, requireAuth });
  } catch (err) {
    fail(`[!] Cannot start the UI server: ${err.message}`, err.exitCode || EXIT.FAIL, flags);
  }

  if (flags.json) {
    // Printed once, after the socket is actually bound, so a caller can read the
    // real port rather than the one it asked for.
    emitJson({ ok: true, url: started.url, host: started.host, port: started.port, requireAuth });
  } else {
    console.log(`\nzstack UI listening on ${started.url}`);
    console.log(`    Runs are recorded in ${process.env.ZSTACK_HISTORY_PATH || '~/.zstack/history.jsonl'}`);
    console.log(`    API keys live in ${keysPath()}`);
    console.log(requireAuth
      ? '    API calls require a key: send "Authorization: Bearer <key>" or run without --require-auth.'
      : '    API calls are open on this bind; pass --require-auth to require a key.');
    console.log('    Press Ctrl-C to stop.\n');
  }

  if (flags.open) openBrowser(started.url);

  await new Promise((resolve) => {
    let closing = false;
    const stop = (signal) => {
      if (closing) return;
      closing = true;
      const log = flags.json ? console.error : console.log;
      log(`\n[>] Stopping the UI server (${signal})...`);
      stopServer(started).then(resolve);
    };
    process.on('SIGINT', () => stop('SIGINT'));
    process.on('SIGTERM', () => stop('SIGTERM'));
  });
  process.exit(EXIT.OK);
}

/**
 * Ask one question on the terminal.
 *
 * With no TTY (a pipe, a CI job) the answer is empty, which every caller treats
 * as the cautious choice: a destructive command then needs its explicit flag
 * rather than proceeding on input nobody gave.
 */
async function askLine(question) {
  if (!process.stdin.isTTY) return '';
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

/** Open a URL in the platform's default browser, best-effort. */
function openBrowser(url) {
  const command =
    process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin' ? ['open', [url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(command[0], command[1], { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    // A browser that will not open is not a reason to refuse to serve.
  }
}

function printShellHelp() {  console.log(`
Session commands:
  /playbook <id>     Pin a playbook for subsequent prompts (/playbook clear to unset)
  /files <a,b>       Attach files (/files clear to unset)
  /role <role>       Pin a role override (/role clear to unset)
  /model <m>         Pin a model override (/model clear to unset)
  /lane <auto|zen|go|hitch|hf>  Pin a provider lane (/lane clear for stored default)
  /json on|off       Toggle JSON output mode
  /context <tokens>  Set the context budget (/context clear for default)
  /status            Show session state
  /help              Show this help
  /exit              Leave the shell
`);
}

async function handleShellSlash(line, state, flags) {
  const [cmd, ...rest] = line.slice(1).split(/\s+/);
  const arg = rest.join(' ').trim();
  const name = cmd.toLowerCase();
  switch (name) {
    case 'exit':
    case 'quit':
      return 'exit';
    case 'help':
      printShellHelp();
      return null;
    case 'status': {
      const stored = getStoredBudget();
      console.log('Session state:');
      console.log(`  playbook: ${state.playbook || '(auto)'}`);
      console.log(`  files: ${(state.files && state.files.length > 0) ? state.files.join(', ') : '(none)'}`);
      console.log(`  role: ${state.role || '(auto)'}`);
      console.log(`  model: ${state.model || '(auto)'}`);
      console.log(`  json: ${state.json ? 'on' : 'off'}`);
      console.log(`  context budget: ${state.contextBudget || '(default 12000)'}`);
      console.log(`  model budget: ${stored.tier} (source: ${stored.source})`);
      console.log(`  lane: ${state.lane || `${normalizeLane(stored.lane)} (stored)`}`);
      return null;
    }
    case 'lane':
      if (!arg || arg.toLowerCase() === 'clear') {
        state.lane = null;
        console.log(`lane: unset (stored default: ${normalizeLane(getStoredBudget().lane)})`);
      } else if (!isKnownLane(arg)) {
        console.log(`[!] Unknown lane "${arg}". Valid lanes: ${Object.keys(LANES).join(', ')}.`);
      } else {
        state.lane = normalizeLane(arg);
        console.log(`lane: ${state.lane}`);
      }
      return null;
    case 'playbook':
      if (!arg) {
        console.log(`playbook: ${state.playbook || '(auto)'}`);
      } else if (arg.toLowerCase() === 'clear') {
        state.playbook = null;
        console.log('playbook: unset (auto)');
      } else if (!z.listPlaybooks().some(p => p.id === arg)) {
        console.log(`[!] Unknown playbook "${arg}".`);
      } else {
        state.playbook = arg;
        console.log(`playbook: ${arg}`);
      }
      return null;
    case 'files':
      if (!arg) {
        console.log(`files: ${(state.files && state.files.length > 0) ? state.files.join(', ') : '(none)'}`);
      } else if (arg.toLowerCase() === 'clear') {
        state.files = [];
        console.log('files: cleared');
      } else {
        state.files = arg.split(',').map(s => s.trim()).filter(Boolean);
        console.log(`files: ${state.files.join(', ')}`);
      }
      return null;
    case 'role':
      if (!arg || arg.toLowerCase() === 'clear') {
        state.role = null;
        console.log('role: unset (auto)');
      } else {
        state.role = arg;
        console.log(`role: ${arg}`);
      }
      return null;
    case 'model':
      if (!arg || arg.toLowerCase() === 'clear') {
        state.model = null;
        console.log('model: unset (auto)');
      } else {
        state.model = arg;
        console.log(`model: ${arg}`);
      }
      return null;
    case 'json':
      if (arg.toLowerCase() === 'on') {
        state.json = true;
        console.log('json: on');
      } else if (arg.toLowerCase() === 'off') {
        state.json = false;
        console.log('json: off');
      } else {
        console.log(`json: ${state.json ? 'on' : 'off'}`);
      }
      return null;
    case 'context': {
      if (!arg || arg.toLowerCase() === 'clear') {
        state.contextBudget = null;
        console.log('context budget: default');
        return null;
      }
      const n = Number(arg);
      if (!Number.isFinite(n) || n <= 0) {
        console.log(`[!] /context expects a positive token count (got "${arg}").`);
        return null;
      }
      state.contextBudget = Math.floor(n);
      console.log(`context budget: ${state.contextBudget}`);
      return null;
    }
    default:
      console.log(`[!] Unknown session command "/${cmd}".`);
      printShellHelp();
      return null;
  }
}

async function handleShell(args) {
  const { flags } = parseArgs(args);
  if (flags.timeoutError !== undefined) {
    fail(`Error: --timeout expects a positive millisecond count (got "${flags.timeoutError}").`, EXIT.USAGE, flags);
  }
  if (!process.stdin.isTTY && !process.env.ZSTACK_SHELL_FORCE) {
    fail('Error: shell requires an interactive terminal (stdin is not a TTY).', EXIT.USAGE, flags);
  }
  const state = {
    playbook: flags.playbook || null,
    files: flags.files || [],
    role: flags.role || null,
    model: flags.model || null,
    lane: flags.lane ? normalizeLane(flags.lane) : null,
    json: !!flags.json,
    contextBudget: flags.contextBudget || null
  };
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  // Queued line reader: readline 'line' events for buffered (piped) input fire
  // whether or not a question is pending, so queue them instead of dropping.
  const pending = [];
  const waiters = [];
  let inputClosed = false;
  rl.on('line', line => {
    if (waiters.length > 0) waiters.shift()(line);
    else pending.push(line);
  });
  rl.on('close', () => {
    inputClosed = true;
    while (waiters.length > 0) waiters.shift()(null);
  });
  const asker = {
    question: async prompt => {
      if (prompt) rl.output.write(prompt);
      if (pending.length > 0) return pending.shift();
      if (inputClosed || rl.closed) return null;
      return await new Promise(resolve => waiters.push(resolve));
    }
  };
  const onSigint = () => {
    console.log('');
    process.exit(EXIT.OK);
  };
  process.on('SIGINT', onSigint);
  try {
    if (!state.json) {
      console.log('\nzstack shell — interactive session (sticky playbook, files, role, model).');
      console.log('Type /help for session commands, /exit to leave.\n');
    } else {
      console.error('zstack shell started (json mode)');
    }
    for (;;) {
      const line = await asker.question(state.json ? '' : 'zstack> ');
      if (line === null) break; // EOF on stdin: exit 0
      const trimmed = String(line || '').trim();
      if (!trimmed) continue;
      if (trimmed.startsWith('/')) {
        const done = await handleShellSlash(trimmed, state, flags);
        if (done === 'exit') break;
        continue;
      }
      const callFlags = {
        ...flags,
        playbook: state.playbook || undefined,
        files: (state.files && state.files.length > 0) ? state.files : [],
        role: state.role || undefined,
        model: state.model || undefined,
        lane: state.lane || flags.lane,
        json: state.json,
        contextBudget: state.contextBudget ?? flags.contextBudget,
        noPrune: flags.noPrune
      };
      try {
        await runOneShotPrompt(trimmed, callFlags, asker);
      } catch (err) {
        if (state.json) emitJson({ ok: false, error: err?.message || String(err) });
        else console.error(`[!] ${err?.message || err}`);
      }
    }
  } finally {
    process.off('SIGINT', onSigint);
    rl.close();
  }
}

function handleAbout(args) {
  const { flags } = parseArgs(args || []);
  const meta = z.about();
  if (flags.json) {
    emitJson({ ok: true, ...meta });
    return;
  }
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

async function handleSchedule(args) {
  const { flags, positional } = parseArgs(args);
  const subcommand = positional[0] || 'list';
  const rest = positional.slice(1);

  if (subcommand === 'list' || subcommand === 'ls') {
    const { schedules } = readSchedules();
    if (flags.json) {
      emitJson({ ok: true, count: schedules.length, schedules });
      return;
    }
    if (schedules.length === 0) {
      console.log('\nNo routines scheduled yet. Add one with: zstack schedule add "<prompt>"');
      console.log('Or with an explicit cron: zstack schedule add "<prompt>" --cron "0 9 * * 1-5"\n');
      return;
    }
    console.log('\n=== zstack Scheduled Routines ===\n');
    const header = `${'ID'.padEnd(10)} ${'NAME'.padEnd(24)} ${'SCHEDULE'.padEnd(28)} ${'POLICY'.padEnd(11)} ${'STATUS'.padEnd(10)} ${'NEXT RUN'}`;
    console.log(header);
    console.log('-'.repeat(100));
    for (const s of schedules) {
      const id = String(s.id).padEnd(10);
      const name = String(s.name || s.prompt || '').slice(0, 22).padEnd(24);
      const sched = `${s.cron} (${describeCron(s.cron)})`.slice(0, 26).padEnd(28);
      const policy = String(s.policy || 'read-only').padEnd(11);
      const status = (s.enabled ? 'enabled' : 'disabled').padEnd(10);
      const next = s.enabled && s.nextRunAt ? new Date(s.nextRunAt).toLocaleString() : 'paused';
      console.log(`${id} ${name} ${sched} ${policy} ${status} ${next}`);
    }
    console.log(`\nTotal: ${schedules.length} routine${schedules.length === 1 ? '' : 's'}\n`);
    return;
  }

  if (subcommand === 'add') {
    const rawPrompt = rest.join(' ').trim();
    if (!rawPrompt) {
      fail('Error: Prompt is required. Usage: zstack schedule add "<prompt>" [--cron "<expr>"]', EXIT.USAGE, flags);
    }
    let cron = flags.cron;
    let taskPrompt = rawPrompt;
    let routineName = flags.name;

    if (!cron) {
      const inferred = inferScheduleFromText(rawPrompt);
      if (inferred.matched) {
        cron = inferred.cron;
        taskPrompt = inferred.cleanedPrompt || rawPrompt;
        if (!routineName) {
          routineName = `${inferred.humanCadence} routine`;
        }
      } else {
        fail('Error: No schedule detected. Specify --cron "<expression>" or include routine wording (e.g. "every morning at 9am check...").', EXIT.USAGE, flags);
      }
    } else {
      const { valid, error } = validateCron(cron);
      if (!valid) {
        fail(`Error: Invalid cron expression "${cron}": ${error}`, EXIT.USAGE, flags);
      }
      if (!routineName) {
        routineName = taskPrompt.slice(0, 30);
      }
    }

    const policy = flags.policy || (flags.apply ? 'apply' : 'read-only');
    const enabled = flags.disabled ? false : true;
    try {
      const schedule = createSchedule({
        name: routineName,
        prompt: taskPrompt,
        cron,
        enabled,
        policy,
        lane: flags.lane,
        playbook: flags.playbook,
        maxTurns: flags.maxTurns,
        projectId: flags.projectId || (typeof flags.project === 'string' ? flags.project : undefined)
      });

      if (flags.json) {
        emitJson({ ok: true, schedule });
        return;
      }

      console.log(`\n[✓] Created routine "${schedule.name}" (${schedule.id})`);
      console.log(`    Schedule: ${schedule.cron} (${describeCron(schedule.cron)})`);
      console.log(`    Policy:   ${schedule.policy}`);
      console.log(`    Next run: ${schedule.nextRunAt || 'disabled'}`);
      console.log(`    Task:     ${schedule.prompt}\n`);
    } catch (err) {
      failWith(err, flags, EXIT.FAIL, '[!] Failed to create schedule');
    }
    return;
  }

  if (subcommand === 'run') {
    const id = rest[0];
    if (!id) {
      fail('Error: Schedule ID is required. Usage: zstack schedule run <id>', EXIT.USAGE, flags);
    }
    const sched = findSchedule(id);
    if (!sched) {
      fail(`No schedule with id "${id}".`, EXIT.FAIL, flags);
    }

    let triggered = false;
    let liveResult = null;
    try {
      const res = await fetch(`http://127.0.0.1:3939/api/schedules/${encodeURIComponent(id)}/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' }
      });
      if (res.ok) {
        liveResult = await res.json();
        triggered = true;
      } else if (res.status === 409) {
        const body = await res.json().catch(() => ({}));
        fail(`Cannot trigger routine: repository is busy (${body.error || 'in flight run'}).`, EXIT.FAIL, flags);
      }
    } catch {
      // Server not running; proceed with direct execution
    }

    if (triggered && liveResult) {
      if (flags.json) {
        emitJson(liveResult);
      } else {
        console.log(`\n[✓] Triggered routine "${sched.name}" (${id}) on live server (Run ID: ${liveResult.runId || 'started'})\n`);
      }
      return;
    }

    try {
      const { RunRegistry } = await import('../src/runs.mjs');
      const registry = new RunRegistry({ zstack: z });
      const scheduler = new Scheduler({ registry });
      const outcome = await scheduler.triggerSchedule(sched);
      if (!outcome.ok) {
        fail(`Failed to trigger routine: ${outcome.error} (${outcome.status})`, EXIT.FAIL, flags);
      }
      if (flags.json) {
        emitJson({ ok: true, scheduleId: id, runId: outcome.runId, status: outcome.status });
      } else {
        console.log(`\n[✓] Triggered routine "${sched.name}" (${id}) (Run ID: ${outcome.runId})\n`);
      }
    } catch (err) {
      failWith(err, flags, EXIT.FAIL, '[!] Failed to run schedule');
    }
    return;
  }

  if (subcommand === 'enable') {
    const id = rest[0];
    if (!id) {
      fail('Error: Schedule ID is required. Usage: zstack schedule enable <id>', EXIT.USAGE, flags);
    }
    const sched = findSchedule(id);
    if (!sched) {
      fail(`No schedule with id "${id}".`, EXIT.FAIL, flags);
    }
    const nextRun = computeNextRun(sched.cron);
    const updated = updateSchedule(id, { enabled: true, nextRunAt: nextRun.toISOString() });
    if (!updated) {
      fail(`Failed to enable schedule "${id}".`, EXIT.FAIL, flags);
    }
    if (flags.json) {
      emitJson({ ok: true, id, enabled: true, nextRunAt: nextRun.toISOString() });
    } else {
      console.log(`[✓] Enabled routine "${sched.name}" (${id}). Next run: ${nextRun.toLocaleString()}`);
    }
    return;
  }

  if (subcommand === 'disable') {
    const id = rest[0];
    if (!id) {
      fail('Error: Schedule ID is required. Usage: zstack schedule disable <id>', EXIT.USAGE, flags);
    }
    const sched = findSchedule(id);
    if (!sched) {
      fail(`No schedule with id "${id}".`, EXIT.FAIL, flags);
    }
    const updated = updateSchedule(id, { enabled: false });
    if (!updated) {
      fail(`Failed to disable schedule "${id}".`, EXIT.FAIL, flags);
    }
    if (flags.json) {
      emitJson({ ok: true, id, enabled: false });
    } else {
      console.log(`[✓] Disabled routine "${sched.name}" (${id}).`);
    }
    return;
  }

  if (subcommand === 'delete' || subcommand === 'rm') {
    const id = rest[0];
    if (!id) {
      fail('Error: Schedule ID is required. Usage: zstack schedule delete <id>', EXIT.USAGE, flags);
    }
    const deleted = deleteSchedule(id);
    if (!deleted) {
      fail(`No schedule with id "${id}".`, EXIT.FAIL, flags);
    }
    if (flags.json) {
      emitJson({ ok: true, deleted: id });
    } else {
      console.log(`[✓] Deleted routine "${id}".`);
    }
    return;
  }

  if (subcommand === 'infer') {
    const text = rest.join(' ').trim();
    if (!text) {
      fail('Error: Text is required to infer routine. Usage: zstack schedule infer "<text>"', EXIT.USAGE, flags);
    }
    const inferred = inferScheduleFromText(text);
    if (flags.json) {
      emitJson({ ok: true, inferred });
      return;
    }
    if (inferred.matched) {
      console.log('\n[✓] Inferred routine schedule:');
      console.log(`    Cadence: ${inferred.humanCadence}`);
      console.log(`    Cron:    ${inferred.cron}`);
      console.log(`    Task:    ${inferred.cleanedPrompt}\n`);
    } else {
      console.log(`\n[!] No schedule cadence detected in "${text}".\n`);
    }
    return;
  }

  fail(`Unknown schedule subcommand "${subcommand}". Allowed: list, add, run, enable, disable, delete, infer.`, EXIT.USAGE, flags);
}

/**
 * `zstack keys` — create, inspect, rotate, and retire API keys.
 *
 * This exists so a credential can be minted without a server, a browser, or a
 * scratch script: `zstack keys new "<name>" --assign <where>` is the whole
 * workflow, and it prints the secret once. Every subcommand resolves its
 * argument the same way — id, then name, then secret prefix — so the short form
 * shown in the list is what an operator can paste back.
 */
async function handleKeys(rawArgs) {
  const { flags, positional } = parseArgs(rawArgs);
  const subcommand = positional[0]?.toLowerCase();
  const rest = positional.slice(1);

  if (flags.expiresError) {
    fail(`Error: --expires expects a positive number of days (got "${flags.expiresError}").`, EXIT.USAGE, flags);
  }

  const describeKey = (key) => {
    const bits = [key.id, key.prefix || '(no prefix)'];
    if (key.assignedTo) bits.push(`@ ${key.assignedTo}`);
    if (key.expired) bits.push('EXPIRED');
    return bits.join('  ');
  };

  if (!subcommand || subcommand === 'list' || subcommand === 'ls') {
    const { keys, corrupted, path } = readKeys();
    if (flags.json) {
      emitJson({ ok: true, count: keys.length, keys, path, corrupted: corrupted || undefined });
      return;
    }
    console.log('\n=== zstack API keys ===\n');
    if (corrupted) {
      console.log(`[!] ${path} is not readable JSON. No key authenticates until it is fixed.`);
    }
    if (keys.length === 0) {
      console.log('No keys yet. Create one with: zstack keys new "<name>" [--assign <where>]\n');
      return;
    }
    for (const key of keys) {
      const name = (key.name || '').slice(0, 28).padEnd(30);
      console.log(`  ${name} ${describeKey(key)}`);
      const facts = [];
      facts.push(`issued ${key.issuedAt ? key.issuedAt.slice(0, 10) : 'unknown'}`);
      if (key.rotations > 0) facts.push(`rotated ${key.rotations}x`);
      facts.push(key.lastUsedAt ? `last used ${key.lastUsedAt.slice(0, 16).replace('T', ' ')}` : 'never used');
      if (key.requestCount > 0) facts.push(`${key.requestCount} requests`);
      if (key.expiresAt) facts.push(`expires ${key.expiresAt.slice(0, 10)}`);
      if (key.notes) facts.push(key.notes);
      console.log(`    ${facts.join(' · ')}`);
    }
    console.log(`\n${keys.length} key${keys.length === 1 ? '' : 's'} in ${path}`);
    console.log('The secret is shown once, at creation. A lost one is rotated: zstack keys rotate <id>\n');
    return;
  }

  if (subcommand === 'new' || subcommand === 'create' || subcommand === 'gen' || subcommand === 'generate') {
    const name = flags.name || rest.join(' ').trim();
    if (!name) {
      fail('Error: a key needs a name. Usage: zstack keys new "<name>" [--assign <where>] [--notes <text>] [--expires <days>]', EXIT.USAGE, flags);
    }
    try {
      const { key, secret } = createKey({
        name,
        assignedTo: flags.assign,
        notes: flags.notes,
        expiresInDays: flags.expires
      });
      if (flags.json) {
        emitJson({ ok: true, key, secret });
        return;
      }
      console.log(`\n[✓] Created key "${key.name}" (${key.id})`);
      if (key.assignedTo) console.log(`    Assigned to: ${key.assignedTo}`);
      if (key.expiresAt) console.log(`    Expires:     ${key.expiresAt.slice(0, 10)}`);
      console.log('');
      console.log(`    ${secret}`);
      console.log('');
      console.log('This is the only time the secret is shown; only its hash is stored.');
      console.log('Use it as:  Authorization: Bearer <key>   (or  x-api-token: <key>)');
      return;
    } catch (err) {
      fail(`[!] ${err.message}`, EXIT.USAGE, flags);
    }
  }

  if (subcommand === 'show') {
    const ref = rest[0];
    if (!ref) fail('Usage: zstack keys show <id|name|prefix> [--json]', EXIT.USAGE, flags);
    const key = findKey(ref);
    if (!key) fail(`[!] No key matching "${ref}".`, EXIT.FAIL, flags);
    if (flags.json) {
      emitJson({ ok: true, key });
      return;
    }
    console.log('');
    console.log(`  Name:        ${key.name}`);
    console.log(`  Id:          ${key.id}`);
    console.log(`  Prefix:      ${key.prefix || '(none)'}`);
    console.log(`  Assigned to: ${key.assignedTo || '(unassigned)'}`);
    console.log(`  Issued:      ${key.issuedAt || 'unknown'}`);
    console.log(`  Rotations:   ${key.rotations}`);
    console.log(`  Expires:     ${key.expired ? `${key.expiresAt} (expired)` : (key.expiresAt || 'never')}`);
    console.log(`  Last used:   ${key.lastUsedAt ? `${key.lastUsedAt}${key.lastUsedFrom ? ` from ${key.lastUsedFrom}` : ''}` : 'never'}`);
    console.log(`  Requests:    ${key.requestCount}`);
    if (key.notes) console.log(`  Notes:       ${key.notes}`);
    console.log('');
    return;
  }

  if (subcommand === 'rotate') {
    const ref = rest[0];
    if (!ref) fail('Usage: zstack keys rotate <id|name|prefix> [--expires <days>] [--json]', EXIT.USAGE, flags);
    try {
      const options = flags.expires !== undefined ? { expiresInDays: flags.expires } : {};
      const { key, secret } = rotateKey(ref, undefined, options);
      if (flags.json) {
        emitJson({ ok: true, key, secret });
        return;
      }
      console.log(`\n[✓] Rotated key "${key.name}" (${key.id}) — rotation ${key.rotations}`);
      console.log('    The previous secret stopped working the moment this ran.');
      console.log('');
      console.log(`    ${secret}`);
      console.log('');
      return;
    } catch (err) {
      fail(`[!] ${err.message}`, err.kind === 'unknown-key' ? EXIT.FAIL : EXIT.USAGE, flags);
    }
  }

  if (subcommand === 'rename' || subcommand === 'assign' || subcommand === 'edit') {
    const ref = rest[0];
    if (!ref) {
      fail(`Usage: zstack keys ${subcommand} <id|name|prefix> [--name <new>] [--assign <where>] [--notes <text>]`, EXIT.USAGE, flags);
    }
    const patch = {};
    if (flags.name !== undefined) patch.name = flags.name;
    if (flags.assign !== undefined) patch.assignedTo = flags.assign;
    if (flags.notes !== undefined) patch.notes = flags.notes;
    if (flags.expires !== undefined) patch.expiresInDays = flags.expires;
    if (Object.keys(patch).length === 0) {
      fail('Error: nothing to change. Pass --name, --assign, --notes, or --expires.', EXIT.USAGE, flags);
    }
    try {
      const key = updateKey(ref, patch);
      if (flags.json) {
        emitJson({ ok: true, key });
        return;
      }
      console.log(`[✓] Updated "${key.name}" (${key.id})${key.assignedTo ? ` — assigned to ${key.assignedTo}` : ''}`);
      return;
    } catch (err) {
      fail(`[!] ${err.message}`, err.kind === 'invalid-key' ? EXIT.USAGE : EXIT.FAIL, flags);
    }
  }

  if (subcommand === 'delete' || subcommand === 'rm' || subcommand === 'remove' || subcommand === 'revoke') {
    const ref = rest[0];
    if (!ref) fail('Usage: zstack keys delete <id|name|prefix> [--yes] [--json]', EXIT.USAGE, flags);
    const key = findKey(ref);
    if (!key) fail(`[!] No key matching "${ref}".`, EXIT.FAIL, flags);
    if (!flags.yes && !flags.json) {
      const answer = await askLine(`Delete key "${key.name}" (${key.id})? Any deployment using it stops working. [y/N] `);
      if (!/^y(es)?$/i.test(answer.trim())) {
        console.log('Cancelled.');
        return;
      }
    }
    try {
      deleteKey(key.id);
      if (flags.json) {
        emitJson({ ok: true, deleted: key.id, key });
        return;
      }
      console.log(`[✓] Deleted key "${key.name}" (${key.id}). It authenticates nothing now.`);
      return;
    } catch (err) {
      fail(`[!] ${err.message}`, EXIT.FAIL, flags);
    }
  }

  if (subcommand === 'verify') {
    // Answers "does this secret still work" without a server, which is the
    // question that comes up when an integration starts failing with 401.
    const secret = rest[0] || (flags.file ? readFileSync(flags.file, 'utf8').trim() : '');
    if (!secret) fail('Usage: zstack keys verify "<secret>" [--json]', EXIT.USAGE, flags);
    const record = verifyKeySecret(secret);
    if (flags.json) {
      emitJson(record
        ? { ok: true, valid: true, key: publicKey(record) }
        : { ok: true, valid: false });
      return;
    }
    if (record) {
      console.log(`[✓] Valid — "${record.name}" (${record.id})${record.assignedTo ? ` @ ${record.assignedTo}` : ''}`);
    } else {
      console.log('[!] Invalid, expired, or unknown. It does not authenticate anything.');
      process.exitCode = EXIT.FAIL;
    }
    return;
  }

  fail(`Unknown keys subcommand "${subcommand}". Allowed: list, new, show, rotate, rename, assign, delete, verify.`, EXIT.USAGE, flags);
}

async function handleWorkfolk(rawArgs) {
  const { flags, positional } = parseArgs(rawArgs);
  const subcommand = positional[0]?.toLowerCase();
  const rest = positional.slice(1);

  if (!subcommand || subcommand === 'list' || subcommand === 'workers' || subcommand === 'roster') {
    try {
      const workers = await fetchWorkfolkRoster({ includeRetired: flags.includeRetired });
      if (flags.json) {
        emitJson({ ok: true, count: workers.length, workers });
        return;
      }
      console.log('\nWorkfolk Worker Roster:');
      console.log('='.repeat(78));
      if (workers.length === 0) {
        console.log('No active workers returned by Workfolk gateway.');
      } else {
        for (const w of workers) {
          const tag = `@${w.tag || w.name}`.padEnd(16);
          const name = (w.name || '').padEnd(18);
          const status = (w.status || 'active').padEnd(10);
          console.log(`${tag} ${name} [${status}] ${w.role || w.description || ''}`);
          if (Array.isArray(w.tools) && w.tools.length > 0) {
            console.log(`  Capabilities: ${w.tools.join(', ')}`);
          }
        }
      }
      console.log('='.repeat(78));
      console.log(`Total: ${workers.length} workers. Dispatch with: zstack workfolk dispatch <tag> "<task>"\n`);
    } catch (err) {
      fail(`Failed to fetch Workfolk roster: ${err.message}`, EXIT.FAIL, flags);
    }
    return;
  }

  if (subcommand === 'status') {
    try {
      const status = await getWorkfolkStatus();
      if (flags.json) {
        emitJson(status);
        return;
      }
      console.log('\nWorkfolk Bridge Status:');
      console.log(`  Gateway URL: ${status.baseUrl}`);
      console.log(`  Configured:  ${status.configured ? 'yes (token found)' : 'no (set WORKFOLK_TOKEN or GATEWAY_WORKERS_TOKEN)'}`);
      console.log(`  Reachability: ${status.ok ? 'connected' : 'unreachable'}`);
      if (status.authValid !== null) {
        console.log(`  Auth valid:   ${status.authValid ? 'yes' : 'no'}`);
      }
      console.log(`  Workers:      ${status.workerCount}`);
      if (status.error) {
        console.log(`  Error:        ${status.error}`);
      }
      console.log('');
    } catch (err) {
      fail(`Failed to check Workfolk status: ${err.message}`, EXIT.FAIL, flags);
    }
    return;
  }

  if (subcommand === 'dispatch') {
    const tag = rest[0];
    const task = rest.slice(1).join(' ').trim() || (flags.file ? readFileSync(flags.file, 'utf8').trim() : '');
    if (!tag) {
      fail('Usage: zstack workfolk dispatch <worker-tag> "<task>" [--wait] [--json]', EXIT.USAGE, flags);
    }
    if (!task) {
      fail('Task is required. Usage: zstack workfolk dispatch <worker-tag> "<task>"', EXIT.USAGE, flags);
    }
    try {
      if (!flags.json) {
        console.log(`Dispatching task to ${tag.startsWith('@') ? tag : '@' + tag}...`);
      }
      const dispatchResult = await dispatchWorkfolkTask(tag, task);
      if (flags.wait) {
        if (!flags.json) {
          console.log(`Job queued: ${dispatchResult.job_id}. Waiting for completion...`);
        }
        const terminalJob = await pollWorkfolkJob(dispatchResult.job_id, {
          onPoll: (job) => {
            if (!flags.json && process.stdout.isTTY) {
              process.stdout.write(`\rJob ${job.job_id} status: ${job.status}... `);
            }
          }
        });
        if (flags.json) {
          emitJson({ ok: true, ...terminalJob });
          return;
        }
        console.log(`\n\n[✓] Job ${terminalJob.job_id} status: ${terminalJob.status}`);
        if (terminalJob.result) {
          console.log('\nResult:');
          console.log(terminalJob.result);
        }
        return;
      }
      if (flags.json) {
        emitJson({ ok: true, ...dispatchResult });
        return;
      }
      console.log(`[✓] Job queued with ID: ${dispatchResult.job_id}`);
      console.log(`Check status with: zstack workfolk job ${dispatchResult.job_id}`);
    } catch (err) {
      fail(`Workfolk dispatch failed: ${err.message}`, EXIT.FAIL, flags);
    }
    return;
  }

  if (subcommand === 'job') {
    const jobId = rest[0];
    if (!jobId) {
      fail('Usage: zstack workfolk job <job-id> [--wait] [--json]', EXIT.USAGE, flags);
    }
    try {
      let job;
      if (flags.wait) {
        job = await pollWorkfolkJob(jobId);
      } else {
        job = await getWorkfolkJobStatus(jobId);
      }
      if (flags.json) {
        emitJson({ ok: true, ...job });
        return;
      }
      console.log(`\nWorkfolk Job: ${job.job_id}`);
      console.log(`  Worker:  @${job.worker_tag || 'unknown'}`);
      console.log(`  Status:  ${job.status}`);
      console.log(`  Task:    ${job.task || ''}`);
      if (job.result) {
        console.log('\nResult:');
        console.log(job.result);
      }
      console.log('');
    } catch (err) {
      fail(`Failed to fetch job ${jobId}: ${err.message}`, EXIT.FAIL, flags);
    }
    return;
  }

  fail(`Unknown workfolk subcommand "${subcommand}". Allowed: list, dispatch, job, status.`, EXIT.USAGE, flags);
}

async function main() {
  const argv = process.argv.slice(2);
  const { cmd, rawArgs } = splitCmd(argv);
  const { flags: globalFlags } = parseArgs(argv);
  if (globalFlags.timeoutError !== undefined) {
    fail(`Error: --timeout expects a positive millisecond count (got "${globalFlags.timeoutError}").`, EXIT.USAGE, globalFlags);
  }
  if (globalFlags.timeoutMs) z.timeoutMs = globalFlags.timeoutMs;
  switch (cmd) {
    case 'status':
      await handleStatus(rawArgs);
      break;
    case 'about':
    case '--about':
    case '-a':
      handleAbout(rawArgs);
      break;
    case 'version':
    case '--version':
    case '-v':
      if (globalFlags.json) emitJson({ ok: true, version: 'zstack v0.1.0' });
      else console.log('zstack v0.1.0');
      break;
    case 'playbooks':
      await handlePlaybooks(rawArgs);
      break;
    case 'principles':
      await handlePrinciples(rawArgs);
      break;
    case 'sync':
      await handleSync(rawArgs);
      break;
    case 'budget':
      await handleBudget(rawArgs);
      break;
    case 'hf':
    case 'huggingface':
      await handleHf(rawArgs);
      break;
    case 'grade':
      await handleGrade(rawArgs);
      break;
    case 'triage':
      await handleTriage(rawArgs);
      break;
    case 'explore':
      await handleExplore(rawArgs);
      break;
    case 'history':
      await handleHistory(rawArgs);
      break;
    case 'shell':
    case 'repl':
      await handleShell(rawArgs);
      break;
    case 'serve':
      await handleServe(rawArgs);
      break;
    case 'skill':
      await handleSkill(rawArgs);
      break;
    case 'schedule':
    case 'schedules':
    case 'cron':
      await handleSchedule(rawArgs);
      break;
    case 'keys':
    case 'key':
    case 'apikeys':
      await handleKeys(rawArgs);
      break;
    case 'workfolk':
    case 'workers':
      await handleWorkfolk(rawArgs);
      break;
    case 'update':
    case '--update': {
      const { flags } = parseArgs(rawArgs);
      if (flags.json) console.error('Checking upstream pstack...');
      await z.update({ apply: flags.apply, check: flags.check });
      break;
    }
    case 'task':
      await handleTask(rawArgs);
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
        await handleStatus(rawArgs);
      } else if (cmd.startsWith('-')) {
        // Flag-like token that is not a known command: genuine unknown input.
        fail(`Error: unknown option or command "${cmd}". Run: zstack help`, EXIT.USAGE, globalFlags);
      } else {
        // Treat as a direct task prompt: zstack "my task prompt..."
        await handleOneShotPrompt([cmd, ...rawArgs]);
      }
      break;
  }
}

main().catch(err => {
  const wantsJson = process.argv.includes('--json');
  if (wantsJson) {
    console.log(JSON.stringify({ ok: false, error: err.message || 'Fatal error' }));
  } else {
    console.error(`Fatal: ${err.message}`);
  }
  process.exit(EXIT.FAIL);
});
