/**
 * Webview shared state — replaces scattered mutable globals.
 * All modules import and mutate this single object.
 */

export interface WebviewState {
  currentModel: string;
  currentActiveSessionId: string;
  isBusy: boolean;
  knownContextSize: number;

  // Streaming state
  currentAgentEl: HTMLElement | null;
  currentAgentText: string;
  thinkingStatusEl: HTMLElement | null;
  pendingText: string;
  flushScheduled: boolean;
  markdownDebounceTimer: ReturnType<typeof setTimeout> | null;

  // Queue
  pendingQueuedTexts: string[];
  prevQueueCount: number;

  // Skills
  selectedSkillNames: Set<string>;
  skillGroupsData: { category: string; skills: { name: string; description: string }[] }[];
}

export function createInitialState(): WebviewState {
  return {
    currentModel: '',
    currentActiveSessionId: '',
    isBusy: false,
    knownContextSize: 0,
    currentAgentEl: null,
    currentAgentText: '',
    thinkingStatusEl: null,
    pendingText: '',
    flushScheduled: false,
    markdownDebounceTimer: null,
    pendingQueuedTexts: [],
    prevQueueCount: 0,
    selectedSkillNames: new Set(),
    skillGroupsData: [],
  };
}
