import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_BRIDGE_URL,
  checkBridgeHealth,
  fetchModelHitchState,
  resolveRoleMapping,
  sendChat,
  runRole as connectorRunRole,
  runPanel as connectorRunPanel,
  syncCursorRules,
  ZSTACK_ROLES
} from './connector.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DEFAULT_ROOT_DIR = join(__dirname, '..');

/**
 * Default system prompt that infuses zstack engineering discipline into all executions.
 */
export const ZSTACK_SYSTEM_PROMPT = `You are an expert engineer executing under the zstack Agent Operating System.
You operate with rigorous engineering discipline, verified outcomes, and zero fluff.
- Write unslopped declarative prose: short, active sentences with no em-dashes (—) or conversational fillers.
- Always name the core data shapes and invariants before writing code.
- Verify against real artifacts (live processes, HTTP responses, database records, test outputs), never proxies or mocks.
- Cite the applicable zstack principles that influenced your decisions and explain the concrete choices they changed.`;

/**
 * Standard classification patterns to map freeform user intent to playbooks.
 */
const PLAYBOOK_TRIGGERS = [
  { type: 'authoring-a-skill', regex: /\b(author(ing)?\s+a?\s*skill|create\s+a?\s*skill|package\s+a?\s*skill|new\s+skill)\b/i, role: 'judgment and prose', principles: ['encode-lessons-in-structure', 'experience-first'] },
  { type: 'autonomous-run', regex: /\b(autonomous|unattended|overnight|batch agent|run loop)\b/i, role: 'feature, refactoring', principles: ['sequence-verifiable-units', 'make-operations-idempotent'] },
  { type: 'pause-safely', regex: /\b(pause(\s+safely)?|checkpoint|stash\s+work|save\s+progress)\b/i, role: 'judgment and prose', principles: ['sequence-verifiable-units', 'prove-it-works'] },
  { type: 'session-pickup', regex: /\b(session\s+pickup|resume\s+session|continue\s+session|pick\s+up\s+where)\b/i, role: 'judgment and prose', principles: ['foundational-thinking', 'outcome-oriented-execution'] },
  { type: 'perf-issue', regex: /\b(perf|performance|slow|latency|bottleneck|leak|memory|cpu|throughput)\b/i, role: 'bug-fix, perf-issue', principles: ['fix-root-causes', 'build-the-lever', 'prove-it-works'] },
  { type: 'runtime-forensics', regex: /\b(deadlock|socket leak|connection pool|oom|corrupt state)\b/i, role: 'bug-fix, perf-issue', principles: ['separate-before-serializing-shared-state', 'fix-root-causes'] },
  { type: 'trace-forensics', regex: /\b(trace|span|telemetry|jaeger|otlp|network delay)\b/i, role: 'bug-fix, perf-issue', principles: ['fix-root-causes', 'prove-it-works'] },
  { type: 'visual-parity', regex: /\b(css|styling|pixel|visual regression|responsive layout)\b/i, role: 'feature, refactoring', principles: ['experience-first', 'prove-it-works'] },
  { type: 'refactoring', regex: /\b(refactor|restructure|clean|cleanup|simplify|deprecate|remove dead|dedup)\b/i, role: 'feature, refactoring', principles: ['laziness-protocol', 'subtract-before-you-add', 'minimize-reader-load'] },
  { type: 'prototype', regex: /\b(prototype|spike|explore|experiment|poc|proof of concept)\b/i, role: 'fast exploration', principles: ['exhaust-the-design-space', 'never-block-on-the-human', 'laziness-protocol'] },
  { type: 'investigation', regex: /\b(investigate|how does|why does|explain|understand|where is)\b/i, role: 'how explorer', principles: ['guard-the-context-window', 'foundational-thinking'] },
  { type: 'opening-a-pr', regex: /\b(pr|pull request|commit summary|diff summary)\b/i, role: 'judgment and prose', principles: ['minimize-reader-load', 'sequence-verifiable-units'] },
  { type: 'eval', regex: /\b(eval|benchmark|accuracy score|quality delta)\b/i, role: 'deep reasoning', principles: ['prove-it-works', 'encode-lessons-in-structure'] },
  { type: 'bug-fix', regex: /\b(bug|fix|broken|error|failing|crash|exception|regression|issue)\b/i, role: 'bug-fix, perf-issue', principles: ['fix-root-causes', 'prove-it-works', 'boundary-discipline'] },
  { type: 'feature', regex: /\b(feature|add|implement|create|build|support|new)\b/i, role: 'feature, refactoring', principles: ['foundational-thinking', 'boundary-discipline', 'sequence-verifiable-units'] }
];

export class ZStack {
  constructor(options = {}) {
    this.baseUrl = options.baseUrl || DEFAULT_BRIDGE_URL;
    this.rootDir = options.rootDir || DEFAULT_ROOT_DIR;
    this.workspaceDir = options.workspaceDir || process.cwd();
    this.defaultSystemPrompt = options.defaultSystemPrompt || ZSTACK_SYSTEM_PROMPT;
  }

  /**
   * Health and connectivity check.
   */
  async status() {
    const health = await checkBridgeHealth(this.baseUrl);
    if (!health.ok) {
      return { ok: false, error: health.error, baseUrl: this.baseUrl };
    }
    const state = await fetchModelHitchState(this.baseUrl);
    const mapping = resolveRoleMapping(state);
    return {
      ok: true,
      baseUrl: this.baseUrl,
      message: health.message,
      activeProviders: state.activeProviders,
      mode: mapping.mode,
      mapping: mapping.models,
      panelModels: mapping.panelList
    };
  }

  /**
   * Return metadata and architecture overview for zstack.
   */
  about() {
    return {
      name: 'zstack',
      version: '0.1.0',
      description: 'Agent Operating System for Rigorous Engineering powered by ModelHitch',
      repository: 'https://github.com/bobbybacklogs/zstack',
      license: 'MIT',
      gateway: this.baseUrl,
      playbookCount: this.listPlaybooks().length,
      principleCount: this.listPrinciples().length,
      subsystems: [
        'Task Playbooks (15 SOPs for features, bug-fixes, refactors, forensics, PRs)',
        'Durable Principles (20 non-negotiable engineering rules cited against changes)',
        'Workload-Specific Model Routing (decouples engineering roles to optimal models)',
        'ModelHitch Integration (local multi-wire resilience gateway on port 3939)'
      ]
    };
  }

  /**
   * List all available task playbooks.
   */
  listPlaybooks() {
    const playbooksDir = join(this.rootDir, 'playbooks');
    if (!existsSync(playbooksDir)) return [];
    return readdirSync(playbooksDir)
      .filter(f => f.endsWith('.md'))
      .map(file => {
        const id = file.replace(/\.md$/, '');
        const content = readFileSync(join(playbooksDir, file), 'utf8');
        const triggerMatch = content.match(/> \*\*Trigger:\*\*\s*(.+)/i);
        const titleMatch = content.match(/^#\s+(.+)$/m);
        return {
          id,
          file,
          path: join(playbooksDir, file),
          title: titleMatch ? titleMatch[1].trim() : id,
          trigger: triggerMatch ? triggerMatch[1].trim() : 'General task'
        };
      });
  }

  /**
   * Get contents of a specific playbook.
   */
  getPlaybook(name) {
    const clean = name.replace(/\.md$/, '');
    const playbookPath = join(this.rootDir, 'playbooks', `${clean}.md`);
    if (!existsSync(playbookPath)) {
      throw new Error(`Playbook not found: ${clean} (searched ${playbookPath})`);
    }
    return readFileSync(playbookPath, 'utf8');
  }

  /**
   * List all 20 principles.
   */
  listPrinciples() {
    const principlesDir = join(this.rootDir, 'principles');
    if (!existsSync(principlesDir)) return [];
    return readdirSync(principlesDir)
      .filter(f => f.endsWith('.md'))
      .map(file => {
        const id = file.replace(/\.md$/, '');
        const content = readFileSync(join(principlesDir, file), 'utf8');
        const applyMatch = content.match(/> \*\*Apply when:\*\*\s*(.+)/i);
        const titleMatch = content.match(/^#\s+(.+)$/m);
        return {
          id,
          file,
          path: join(principlesDir, file),
          title: titleMatch ? titleMatch[1].trim() : id,
          applyWhen: applyMatch ? applyMatch[1].trim() : 'General engineering decisions'
        };
      });
  }

  /**
   * Get contents of a specific principle.
   */
  getPrinciple(name) {
    const clean = name.replace(/\.md$/, '');
    const principlePath = join(this.rootDir, 'principles', `${clean}.md`);
    if (!existsSync(principlePath)) {
      throw new Error(`Principle not found: ${clean} (searched ${principlePath})`);
    }
    return readFileSync(principlePath, 'utf8');
  }

  /**
   * Classify a user prompt into a matching playbook and relevant principles.
   */
  classifyPrompt(prompt) {
    for (const rule of PLAYBOOK_TRIGGERS) {
      if (rule.regex.test(prompt)) {
        return {
          type: rule.type,
          role: rule.role,
          principles: rule.principles,
          playbookFile: `playbooks/${rule.type}.md`
        };
      }
    }
    return {
      type: 'feature',
      role: 'feature, refactoring',
      principles: ['foundational-thinking', 'boundary-discipline', 'sequence-verifiable-units'],
      playbookFile: 'playbooks/feature.md'
    };
  }

  /**
   * Execute a structured task via zstack SOP and ModelHitch.
   */
  async task(options) {
    const prompt = typeof options === 'string' ? options : options.prompt;
    if (!prompt) throw new Error('Task prompt is required');

    // 1. Determine Playbook & Principles
    const classification = this.classifyPrompt(prompt);
    const playbookType = options.playbook || options.type || classification.type;
    const roleName = options.role || classification.role;
    const principleNames = options.principles || classification.principles;

    // Load playbook & principles text
    let playbookContent = '';
    try {
      playbookContent = this.getPlaybook(playbookType);
    } catch {
      playbookContent = `# Task: ${playbookType}`;
    }

    const principlesText = principleNames.map(p => {
      try {
        return `### Principle: ${p}\n${this.getPrinciple(p)}`;
      } catch {
        return `### Principle: ${p}`;
      }
    }).join('\n\n');

    // Load attached context files if provided
    let filesContext = '';
    if (Array.isArray(options.files) && options.files.length > 0) {
      filesContext = '\n\n## Attached Context Files:\n' + options.files.map(filePath => {
        const fullPath = join(this.workspaceDir, filePath);
        if (existsSync(fullPath)) {
          const content = readFileSync(fullPath, 'utf8');
          return `### File: ${filePath}\n\`\`\`\n${content}\n\`\`\``;
        }
        return `### File: ${filePath} (file not found on disk)`;
      }).join('\n\n');
    }

    // Assemble system instructions
    const systemPrompt = [
      this.defaultSystemPrompt,
      options.system || '',
      '\n## Applicable Task Playbook:\n' + playbookContent,
      '\n## Applicable Principles:\n' + principlesText
    ].filter(Boolean).join('\n\n');

    // Resolve assigned model from ModelHitch
    const state = await fetchModelHitchState(this.baseUrl);
    const mapping = resolveRoleMapping(state);
    const targetModel = options.model || mapping.models[roleName] || mapping.models['feature, refactoring'];

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: prompt + filesContext }
    ];

    const chatRes = await sendChat({
      model: targetModel,
      messages,
      baseUrl: this.baseUrl,
      temperature: options.temperature,
      maxTokens: options.maxTokens
    });

    return {
      content: chatRes.content,
      model: chatRes.model,
      role: roleName,
      playbook: playbookType,
      principles: principleNames,
      usage: chatRes.usage,
      durationMs: chatRes.durationMs,
      raw: chatRes.raw
    };
  }

  /**
   * Run a prompt directly against an assigned role.
   */
  async runRole(role, prompt, options = {}) {
    return await connectorRunRole(role, prompt, {
      ...options,
      baseUrl: this.baseUrl
    });
  }

  /**
   * Run an adversarial panel critique across multiple distinct model families.
   */
  async panel(prompt, options = {}) {
    return await connectorRunPanel(prompt, {
      ...options,
      baseUrl: this.baseUrl
    });
  }

  /**
   * Synchronize Cursor rule files with active ModelHitch models.
   */
  async syncRules(options = {}) {
    const state = await fetchModelHitchState(this.baseUrl);
    const mapping = resolveRoleMapping(state);
    return syncCursorRules({ mapping, project: options.project });
  }
}

/**
 * Top-level factory and utility helpers.
 */
export function createZStack(options = {}) {
  return new ZStack(options);
}

export async function runTask(promptOrOptions) {
  const z = new ZStack();
  return await z.task(typeof promptOrOptions === 'string' ? { prompt: promptOrOptions } : promptOrOptions);
}

export async function runPanel(prompt, options = {}) {
  const z = new ZStack(options);
  return await z.panel(prompt, options);
}
