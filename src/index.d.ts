export interface ZStackOptions {
  baseUrl?: string;
  rootDir?: string;
  workspaceDir?: string;
  defaultSystemPrompt?: string;
  timeoutMs?: number;
}

export interface PlaybookInfo {
  id: string;
  file: string;
  path: string;
  title: string;
  trigger: string;
  keywords?: string[];
  requires?: string[];
  version?: string | null;
}

export interface PrincipleInfo {
  id: string;
  file: string;
  path: string;
  title: string;
  applyWhen: string;
  keywords?: string[];
  requires?: string[];
  version?: string | null;
}

export interface PromptClassification {
  type: string;
  role: string;
  principles: string[];
  playbookFile: string;
}

export interface PlaybookCandidate {
  type: string;
  role: string;
  principles: string[];
  playbookFile: string;
  score: number;
  reason: string;
}

export interface DetailedClassification extends PromptClassification {
  candidates: PlaybookCandidate[];
  confidence: number;
  ambiguous: boolean;
}

export interface TaskOptions {
  prompt: string;
  playbook?: string;
  type?: string;
  role?: string;
  principles?: string[];
  files?: string[];
  system?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  semantic?: boolean;
  contextBudget?: number;
  contextTokens?: number;
  noPrune?: boolean;
  timeoutMs?: number;
  /** Provider lane override for this task: auto | zen | go | hitch. */
  lane?: string;
}

export interface TaskResult {
  content: string;
  model: string;
  role: string;
  playbook: string;
  principles: string[];
  classification?: {
    type: string;
    candidates: PlaybookCandidate[];
    confidence: number | null;
    ambiguous: boolean;
  };
  context?: {
    estimatedTokens: number;
    budgetTokens: number;
    trimmed: string[];
    omittedPrinciples: string[];
  };
  contextNotes?: string[] | null;  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  durationMs: number;
  raw: any;
}

/**
 * Options for an agentic run: the model gets tools, its calls execute, and the
 * results feed back until the task is done or `maxTurns` is reached.
 */
export interface AgentOptions {
  prompt: string;
  playbook?: string;
  type?: string;
  role?: string;
  model?: string;
  /** Provider lane override for this run: auto | zen | go | hitch. */
  lane?: string;
  /** Directory the agent reads and writes. Defaults to the zstack workspace. */
  workspaceDir?: string;
  /**
   * Approve mutating tool calls. Without it a call that could write is declined
   * and the model is told so, which is what makes the default read-only.
   */
  apply?: boolean;
  /** Model turns before the loop stops. The harness default is 8. */
  maxTurns?: number;
  /** Run the read-only reviewer over the change once the run finishes. */
  review?: boolean;
  /**
   * Let the harness risk-classify mutating calls and auto-approve the ones it
   * calls safe. Defaults to true, and is ignored when `apply` is set.
   */
  autoApproveSafe?: boolean;
  /** Skip the zstack system prompt and playbook injection. */
  noZstack?: boolean;
  /** Extra arguments passed to the harness CLI verbatim. */
  harnessArgs?: string[];
  /** Run deadline in ms. `0` or absent means no deadline. */
  timeoutMs?: number;
  /** Called for every harness event, in order, as it arrives. */
  onEvent?: (event: AgentEvent) => void;
  /** Called with raw stderr chunks from the harness. */
  onStderr?: (chunk: string) => void;
}

/** One event from the harness NDJSON stream. `type` discriminates the shape. */
export interface AgentEvent {
  type: 'run-start' | 'text' | 'tool' | 'approval' | 'turn' | 'done' | string;
  at?: string;
  turn?: number;
  text?: string;
  name?: string;
  args?: Record<string, unknown>;
  outcome?: string;
  durationMs?: number;
  truncated?: boolean;
  bytes?: number;
  tool?: string;
  decision?: string;
  risk?: string;
  tokens?: number;
  totalTokens?: number;
  turns?: number;
  tools?: number;
  changes?: Array<{ name: string; added: number; removed: number }>;
  sessionId?: string;
  schema?: number;
  model?: string;
  provider?: string;
  workspace?: string;
  playbook?: string;
  approvals?: string;
  task?: string;
}

/** One line of the progress view for a run. */
export interface AgentStep {
  kind: 'start' | 'turn' | 'tool' | 'approval';
  turn?: number | null;
  name?: string;
  target?: string;
  outcome?: string;
  durationMs?: number | null;
  truncated?: boolean;
  bytes?: number | null;
  tool?: string;
  decision?: string;
  risk?: string | null;
  tokens?: number | null;
  model?: string | null;
  workspace?: string | null;
}

export interface AgentResult {
  /** The model's closing message. */
  content: string;
  /** Everything the model said across turns, in order. */
  narrative: string;
  model: string | null;
  role: string;
  playbook: string;
  principles: string[];
  classification: {
    type: string;
    candidates: PlaybookCandidate[];
    confidence: number | null;
    ambiguous: boolean;
  };
  applied: boolean;
  workspaceDir: string;
  playbookInjected: boolean;
  ok: boolean;
  exitCode: number;
  turns: number;
  toolCalls: number;
  failedTools: number;
  declinedTools: number;
  approvals: Array<{ tool: string; decision: string; risk: string | null }>;
  changes: Array<{ name: string; added: number; removed: number }>;
  /** Files touched by a successful writer tool, with the tool that wrote them. */
  fileChanges: Array<{ path: string; tool: string; turn: number | null }>;
  steps: AgentStep[];
  events: AgentEvent[];
  usage: { total_tokens: number } | null;
  durationMs: number | null;
  sessionId: string | null;
  malformedEvents: number;
  harness: { source: string | null; schema: number | null };
}

export interface PanelCritique {
  model: string;
  ok: boolean;
  content?: string;
  error?: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  durationMs?: number;
}

export interface BridgeHealth {
  ok: boolean;
  message?: string;
  error?: string;
}

export interface ModelHitchState {
  baseUrl: string;
  config: any;
  keys: Record<string, string>;
  models: Array<{ id: string; object?: string; owned_by?: string }>;
  activeProviders: string[];
}

export interface RoleMapping {
  mode: 'opencode-zen' | 'opencode-go' | 'opencode-zen-go' | 'modelhitch-multi-provider' | 'modelhitch-config-pinned';
  models: Record<string, string>;
  panelList: string[];
  /** Lane actually used to resolve models. */
  lane?: 'zen' | 'go' | 'hitch';
}

export interface AboutInfo {
  name: string;
  version: string;
  description: string;
  repository: string;
  license: string;
  gateway: string;
  playbookCount: number;
  principleCount: number;
  subsystems: string[];
}

export declare class ZStack {
  baseUrl: string;
  rootDir: string;
  workspaceDir: string;
  defaultSystemPrompt: string;
  timeoutMs?: number;

  constructor(options?: ZStackOptions);

  about(): AboutInfo;

  status(): Promise<{
    ok: boolean;
    baseUrl: string;
    message?: string;
    error?: string;
    activeProviders?: string[];
    mode?: string;
    mapping?: Record<string, string>;
    panelModels?: string[];
  }>;

  listPlaybooks(): PlaybookInfo[];
  getPlaybook(name: string): string;

  listPrinciples(): PrincipleInfo[];
  getPrinciple(name: string): string;

  classifyPrompt(prompt: string): PromptClassification;

  classifyPromptDetailed(prompt: string): DetailedClassification;

  task(options: string | TaskOptions): Promise<TaskResult>;

  /**
   * Run an agentic task: the model gets tools, its calls execute, and the
   * results feed back until the task is done or `maxTurns` is reached.
   *
   * Use `task` for a single completion that cannot change anything. Without
   * `apply`, mutating calls are declined, so the default run is read-only.
   */
  agent(options: string | AgentOptions): Promise<AgentResult>;

  runRole(role: string, prompt: string, options?: any): Promise<TaskResult>;

  panel(prompt: string, options?: any): Promise<PanelCritique[]>;

  syncRules(options?: { project?: boolean; lane?: string }): Promise<string>;

  getBudget(): StoredBudget;
  setBudget(tier: string, source?: string, lane?: string | null): Promise<BudgetInfo>;
  getBudgetMapping(cachedState?: ModelHitchState | null, lane?: string | null): Promise<BudgetInfo>;
  resolveRoleMapping(state: ModelHitchState, lane?: string | null): Promise<BudgetInfo & RoleMapping>;

  checkUpstream(options?: { token?: string; statePath?: string }): Promise<any>;

  update(options?: { apply?: boolean; yes?: boolean; token?: string; statePath?: string }): Promise<any>;
}

export declare function createZStack(options?: ZStackOptions): ZStack;
export declare function runTask(promptOrOptions: string | TaskOptions): Promise<TaskResult>;
export declare function runPanel(prompt: string, options?: any): Promise<PanelCritique[]>;
export declare function checkBridgeHealth(baseUrl?: string, options?: any): Promise<BridgeHealth>;
export declare function fetchModelHitchState(baseUrl?: string, options?: any): Promise<ModelHitchState>;
export declare function resolveRoleMapping(state: ModelHitchState, options?: { lane?: string }): RoleMapping;
export declare function scorePlaybookTriggers(text: string): PlaybookCandidate[];
export declare function syncCursorRules(options?: { mapping: RoleMapping; project?: boolean; budget?: BudgetInfo }): string;
export declare const DEFAULT_BRIDGE_URL: string;
export declare const ZSTACK_ROLES: readonly string[];
export declare const ZSTACK_SYSTEM_PROMPT: string;

export type BudgetTierId = 'low-med' | 'med-high' | 'high' | 'max';
export type BudgetSourceId = 'config' | 'catalog';
export type LaneId = 'auto' | 'zen' | 'go' | 'hitch';

export interface BudgetTierInfo {
  name: string;
  description: string;
  profile: string;
}

export interface LaneInfo {
  id: LaneId;
  name: string;
  prefix: string | null;
  description: string;
}

export interface BudgetInfo {
  tier: string;
  tierInfo: BudgetTierInfo;
  source: BudgetSourceId;
  sourceDescription: string;
  /** Lane actually used to resolve models (auto is resolved to zen or hitch). */
  lane: Exclude<LaneId, 'auto'>;
  /** Lane as requested before auto-resolution. */
  requestedLane: LaneId;
  laneInfo: LaneInfo;
  /** Gateway mode label, e.g. 'opencode-zen' | 'opencode-go' | 'modelhitch-multi-provider'. */
  mode: string;
  /** False when source=config pins models from ModelHitch policy, bypassing the lane. */
  laneApplied: boolean;
  models: Record<string, string>;
  panelList: string[];
}

export interface StoredBudget {
  tier: string;
  source: BudgetSourceId;
  lane: LaneId;
  lastUpdated: string;
}

export declare const BUDGET_TIERS: Record<string, BudgetTierInfo>;
export declare const BUDGET_SOURCES: Record<string, string>;
export declare const LANES: Record<LaneId, LaneInfo>;
export declare function normalizeLane(lane?: string | null): LaneId;
export declare function isKnownLane(lane?: string | null): boolean;
export declare function hasOpenCodeKey(keys?: Record<string, unknown>): boolean;
export declare function getStoredBudget(filePath?: string): StoredBudget;
export declare function saveStoredBudget(data: Partial<StoredBudget>, filePath?: string): StoredBudget;
export declare function resolveBudgetMapping(options: { tier?: string; source?: string; lane?: string; state: ModelHitchState }): BudgetInfo;
export declare function promptAndSetBudget(options?: any): Promise<{ applied: boolean; budget: BudgetInfo; rulePath?: string }>;

export declare const CLASSIFY_CONFIDENCE_THRESHOLD: number;
export declare const CLASSIFY_AMBIGUITY_MARGIN: number;
export declare const CLASSIFY_MAX_CANDIDATES: number;

export interface SemanticCandidate {
  type: string;
  score: number;
  reason: string;
}

export declare const ROUTER_EMBEDDING_MODEL: string;
export declare const ROUTER_MIN_SCORE: number;
export declare const ROUTER_CACHE_FILE: string;
export declare function hashContent(text: string): string;
export declare function cosineSimilarity(a: number[], b: number[]): number;
export declare function fetchEmbeddings(texts: string[], options?: any): Promise<number[][]>;
export declare function getPlaybookEmbeddings(options?: any): Promise<Record<string, { trigger: string; hash: string; vector: number[] }> | null>;
export declare function classifyPromptSemantic(prompt: string, options?: any): Promise<{ type: string; score: number; candidates: SemanticCandidate[] } | null>;

export declare const DEFAULT_CONTEXT_BUDGET_TOKENS: number;
export declare function estimateTokens(text: string): number;
export declare function extractHeader(content: string, maxLines?: number): string;
export declare function planContext(options?: any): {
  withinBudget: boolean;
  estimatedTokens: number;
  budgetTokens: number;
  filesContext: string;
  playbookText: string;
  principlesText: string;
  trimmed: string[];
  omittedPrinciples: string[];
  aborted: boolean;
  abortReason: string | null;
};

export interface GradeVerdict {
  principle: string;
  applies: boolean;
  verdict: 'pass' | 'warn' | 'fail';
  rationale: string;
  evidence: string[];
}

export declare const GRADER_MAX_CHUNK_CHARS: number;
export declare const GRADER_MAX_PRINCIPLES: number;
export declare function splitDiffIntoChunks(diffText: string, maxChars?: number): Array<{ index: number; total: number; header: string; body: string; truncated?: boolean }>;
export declare function rankPrinciples(diffText: string, options?: any): Array<{ id: string; score: number; snippet: string }>;
export declare function validateVerdicts(value: any): { ok: boolean; error?: string; verdicts?: GradeVerdict[] };
export declare function gradeDiff(diffText: string, options?: any): Promise<{
  verdicts: GradeVerdict[];
  chunked: boolean;
  principles: string[];
  model: string;
  raw: string;
  retried?: boolean;
  parseError?: string;
}>;
export declare function formatVerdictTable(verdicts: GradeVerdict[]): string;

export declare const DEFAULT_GATEWAY_TIMEOUT_MS: number;
export declare const GATEWAY_MAX_ATTEMPTS: number;
export declare const GATEWAY_BACKOFF_BASE_MS: number;
export declare const GATEWAY_BACKOFF_CAP_MS: number;
export declare const GATEWAY_RETRYABLE_STATUS: Set<number>;
export declare function resolveGatewayTimeoutMs(options?: any): number;
export declare class GatewayError extends Error {
  kind: 'unreachable' | 'timeout' | 'http' | 'parse';
  status: number | null;
  baseUrl?: string;
  attempts: number;
}
export declare function parseRetryAfterMs(value: any, nowMs?: number): number | null;
export declare function gatewayFetch(url: string, options?: any): Promise<{ data: any; status: number; attempts: number }>;

export interface ManifestDoc {
  id?: string;
  title?: string;
  applyWhen?: string;
  keywords?: string[];
  requires?: string[];
  version?: string;
  [key: string]: any;
}

export declare function parseDoc(text: string, source?: string): { data: ManifestDoc | null; body: string; fallback: boolean };
export declare function validateDocs(docs: Array<{ source?: string; id?: string; data?: ManifestDoc | null }>): { ok: boolean; errors: string[] };

export interface TriageCandidate {
  playbook: string;
  trigger: string;
  confidence: number;
  reason: string;
  nextCommands: string[];
}

export declare const TRIAGE_DEFAULT_BUDGET_TOKENS: number;
export declare const TRIAGE_MAX_CANDIDATES: number;
export declare function capTriageInput(input: any, options?: any): { text: string; trimmed: boolean; estimatedTokens: number; budgetTokens: number; note: string | null };
export declare function splitFailures(text: any): string[];
export declare function heuristicTriage(text: any, options?: any): TriageCandidate[];
export declare function triageFailure(options?: any): Promise<{ candidates: TriageCandidate[]; heuristicOnly: boolean; notice: string | null; notes: string[]; retried?: boolean }>;

export declare const OFFLOAD_DEFAULT_ROLE: string;
export declare const OFFLOAD_DEFAULT_BUDGET_TOKENS: number;
export declare const OFFLOAD_DEFAULT_MAX_FILES: number;
export declare const OFFLOAD_DEFAULT_MAX_FILE_BYTES: number;
export declare function walkPaths(paths: string[], options?: any): Promise<string[]>;
export declare function rankOffloadFiles(query: string, filesWithText: Array<{ file: string; content: string }>): Array<{ file: string; score: number; fileHits: number; contentHits: number }>;
export declare function runContextOffload(options?: any, deps?: any): Promise<{
  ok: boolean;
  answer: string;
  findings: Array<{ file: string; line?: number; claim: string; confidence: number | null }>;
  uncovered?: string[];
  filesScanned: number;
  filesAttached: number;
  estimatedTokens: number;
  omitted: string[];
  model: string | null;
  role: string;
  durationMs: number;
  error?: string;
}>;
export declare function formatOffloadReport(result: any): string;

export declare const HISTORY_PREVIEW_CHARS: number;
export declare const HISTORY_DEFAULT_LIMIT: number;
export declare function historyPath(pathOverride?: string): string;
export declare function appendHistory(entry: any, pathOverride?: string): boolean;
export declare function readHistory(options?: any): { entries: any[]; skipped: number; total: number };
export declare function lastEntry(pathOverride?: string): any;
export declare function needsRerunConfirm(entry: any): boolean;
export declare function resetHistoryWarnings(): void;
