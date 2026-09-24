export interface ZStackOptions {
  baseUrl?: string;
  rootDir?: string;
  workspaceDir?: string;
  defaultSystemPrompt?: string;
}

export interface PlaybookInfo {
  id: string;
  file: string;
  path: string;
  title: string;
  trigger: string;
}

export interface PrincipleInfo {
  id: string;
  file: string;
  path: string;
  title: string;
  applyWhen: string;
}

export interface PromptClassification {
  type: string;
  role: string;
  principles: string[];
  playbookFile: string;
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
}

export interface TaskResult {
  content: string;
  model: string;
  role: string;
  playbook: string;
  principles: string[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  durationMs: number;
  raw: any;
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
  mode: 'opencode-zen-go' | 'modelhitch-multi-provider';
  models: Record<string, string>;
  panelList: string[];
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

  task(options: string | TaskOptions): Promise<TaskResult>;

  runRole(role: string, prompt: string, options?: any): Promise<TaskResult>;

  panel(prompt: string, options?: any): Promise<PanelCritique[]>;

  syncRules(options?: { project?: boolean }): Promise<string>;
}

export declare function createZStack(options?: ZStackOptions): ZStack;
export declare function runTask(promptOrOptions: string | TaskOptions): Promise<TaskResult>;
export declare function runPanel(prompt: string, options?: any): Promise<PanelCritique[]>;
export declare function checkBridgeHealth(baseUrl?: string): Promise<BridgeHealth>;
export declare function fetchModelHitchState(baseUrl?: string): Promise<ModelHitchState>;
export declare function resolveRoleMapping(state: ModelHitchState): RoleMapping;
export declare function syncCursorRules(options?: { mapping: RoleMapping; project?: boolean }): string;
export declare const DEFAULT_BRIDGE_URL: string;
export declare const ZSTACK_ROLES: readonly string[];
export declare const ZSTACK_SYSTEM_PROMPT: string;
