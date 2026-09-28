#!/usr/bin/env node

import { createInterface } from 'node:readline/promises';
import { existsSync, readFileSync } from 'node:fs';
import { ZStack, DEFAULT_BRIDGE_URL, fetchModelHitchState } from '../src/index.mjs';
import { BUDGET_TIERS, BUDGET_SOURCES, LANES, getStoredBudget, isKnownLane, normalizeLane, promptAndSetBudget } from '../src/budget.mjs';
import { gradeDiff, formatVerdictTable } from '../src/grader.mjs';
import { appendHistory, readHistory, lastEntry, needsRerunConfirm, HISTORY_PREVIEW_CHARS } from '../src/history.mjs';
import { triageFailure } from '../src/triage.mjs';
import { runContextOffload, formatOffloadReport } from '../src/subagent.mjs';
import { formatEventLine, createProgressRenderer, explainEmptyContent, resolveHarnessEntry, harnessEntryExists, observeGitStatus } from '../src/harness.mjs';

/** Structured exit codes: 0 success, 1 failure, 2 usage, 3 gateway, 4 partial. */
export const EXIT = { OK: 0, FAIL: 1, USAGE: 2, GATEWAY: 3, PARTIAL: 4 };

/** Map gateway failure kinds to the documented exit codes. */
export function exitForKind(kind) {
  if (kind === 'unreachable' || kind === 'timeout') return EXIT.GATEWAY;
  return EXIT.FAIL; // http, parse, unknown
}

const KNOWN_COMMANDS = new Set([
  'task', 'prompt', 'run', 'panel', 'arena', 'interrogate', 'budget', 'grade',
  'triage', 'explore', 'history', 'shell', 'repl',
  'status', 'sync', 'update', 'playbooks', 'principles', 'about', 'version', 'help'
]);

const z = new ZStack();

// Parse flags (--files, --role, --model, --project, --apply, -y, --check,
// --tier, --source, --confirm, --json, --no-prune, --context-budget, --file,
// --playbook, --timeout, --paths, --max-files, --limit, --last, --rerun, --live,
// --agent, --max-turns, --review)
function parseArgs(args) {
  const flags = { files: [], project: false, apply: false, check: false, confirm: false, yes: false, json: false, noPrune: false, live: true, last: false, rerun: false, agent: false, review: false };
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--project') {
      flags.project = true;
    } else if (arg === '--agent') {
      flags.agent = true;
    } else if (arg === '--review') {
      flags.review = true;
    } else if (arg === '--max-turns' && i + 1 < args.length) {
      const n = Number(args[++i]);
      if (!Number.isInteger(n) || n <= 0) {
        flags.maxTurnsError = args[i];
      } else {
        flags.maxTurns = n;
      }
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
    } else if (arg === '--zen' || arg === '--go' || arg === '--hitch') {
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
    appendHistory(fields);
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
  zstack budget [tier] [--source config|catalog] [--lane auto|zen|go|hitch] [--confirm]
                                                   Preview + confirm model budget mapping
  zstack grade [--file <diff>] [--json]            Grade a diff against the 20 principles
  zstack triage [--file <log>] [--json]            Rank playbooks for failure output
  zstack explore "<query>" [--paths src,tests]     Distill bulk file reads via a subagent
  zstack history [--limit N] [--steps] [--json]    Show recent runs (--last --rerun repeats)
  zstack shell | repl                              Start an interactive session with sticky context
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
  Shortcuts: --zen, --go, --hitch. A single request can override the stored lane,
  for example: zstack --go "Fix the flaky retry test"

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
  --lane <auto|zen|go|hitch> Provider lane for this invocation (overrides stored lane)
  --zen, --go, --hitch       Shortcuts for --lane zen | go | hitch
  --agent                    Run the agentic tool loop (single completion without it)
  --apply, -y                Agent: approve mutating calls so files can change
                             (also: zstack update, record upstream sync checkpoint)
  --max-turns <n>            Agent: model turns before the loop stops (harness default 8)
  --review                   Agent: run the read-only reviewer over the change afterwards
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
  return !!(flags.agent || flags.apply || flags.project);
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
async function runAgentPrompt(prompt, playbookId, classification, flags) {
  const mode = flags.apply ? 'apply' : 'read-only';
  if (!flags.json) {
    console.log(`[>] Agentic run (${mode}${flags.maxTurns ? `, max ${flags.maxTurns} turns` : ''}) in ${flags.project ? process.cwd() : 'the zstack workspace'}`);
    if (!flags.apply) {
      console.log('    Mutating tool calls will be declined. Pass --apply to let the agent change files.');
    }
  }

  const started = Date.now();
  const steps = [];
  // Coalesces streamed text deltas into readable blocks; `push` and `flush`
  // keep the live view identical to what run history records.
  const renderer = createProgressRenderer({
    write: (line) => console.log(line)
  });
  try {
    const res = await z.agent({
      ...agentOptions(prompt, playbookId, flags),
      onEvent: (event) => {
        steps.push(event);
        if (flags.json) {
          // One record per line on stderr, keeping stdout parseable.
          console.error(JSON.stringify({ zstack: 'step', ...event }));
          return;
        }
        renderer.push(event);
      }
    });
    if (!flags.json) renderer.flush();

    recordRun({
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
      turns: res.turns,
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
        workspace: res.workspaceDir,
        turns: res.turns,
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

    reportProgression(res, Date.now() - started, mode);
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
    if (err?.kind === 'harness-missing') {
      fail(
        `${err.message}\n    Install it with: npm i -g modelhitch`,
        EXIT.FAIL,
        flags
      );
    }
    recordRun({
      command: 'agent',
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

Tiers: low-med | med-high | high | max
Sources: config (A: config-pinned models) | catalog (B: provider-aligned presets)
Lanes:   auto (default) | zen (OpenCode Zen) | go (OpenCode Go) | hitch (ModelHitch routing)
  Shortcuts: --zen, --go, --hitch set the lane without --lane.
`);
    return;
  }
  const stored = getStoredBudget();
  const tierArg = (positional[0] || flags.tier || stored.tier || 'med-high').toLowerCase();
  const sourceArg = (flags.source || stored.source || 'catalog').toLowerCase();
  const laneArg = normalizeLane(flags.lane || stored.lane);
  if (!isKnownLane(flags.lane)) {
    fail(`Error: unknown lane "${flags.lane}". Valid lanes: auto, zen, go, hitch`, EXIT.USAGE, flags);
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

function printShellHelp() {
  console.log(`
Session commands:
  /playbook <id>     Pin a playbook for subsequent prompts (/playbook clear to unset)
  /files <a,b>       Attach files (/files clear to unset)
  /role <role>       Pin a role override (/role clear to unset)
  /model <m>         Pin a model override (/model clear to unset)
  /lane <auto|zen|go|hitch>  Pin a provider lane (/lane clear for stored default)
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
        console.log(`[!] Unknown lane "${arg}". Valid lanes: auto, zen, go, hitch.`);
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
