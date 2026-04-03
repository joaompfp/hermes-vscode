import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface ModelMenuItem {
  id: string;
  label: string;
  command: string;
}

export interface ModelMenuGroup {
  group: string;
  items: ModelMenuItem[];
}

interface HermesModelRecord {
  id?: string;
  name?: string;
}

interface HermesModelCache {
  anthropic?: {
    models?: Record<string, HermesModelRecord>;
  };
  openai?: {
    models?: Record<string, HermesModelRecord>;
  };
}

const ANTHROPIC_MODEL_IDS = [
  'claude-opus-4-1-20250805',
  'claude-opus-4-20250514',
  'claude-opus-4-5-20251101',
  'claude-opus-4-6',
  'claude-sonnet-4-20250514',
  'claude-sonnet-4-5-20250929',
  'claude-sonnet-4-6',
  'claude-3-haiku-20240307',
  'claude-haiku-4-5-20251001',
];

const OPENAI_CODEX_MODEL_IDS = [
  'gpt-5.4-mini',
  'gpt-5.4',
  'gpt-5.3-codex',
  'gpt-5.2-codex',
  'gpt-5.2',
  'gpt-5.1-codex-max',
  'gpt-5.1-codex-mini',
  'gpt-5.3-codex-spark',
];

const FALLBACK_LABELS: Record<string, string> = {
  'claude-opus-4-1-20250805': 'Claude Opus 4.1',
  'claude-opus-4-20250514': 'Claude Opus 4',
  'claude-opus-4-5-20251101': 'Claude Opus 4.5',
  'claude-opus-4-6': 'Claude Opus 4.6',
  'claude-sonnet-4-20250514': 'Claude Sonnet 4',
  'claude-sonnet-4-5-20250929': 'Claude Sonnet 4.5',
  'claude-sonnet-4-6': 'Claude Sonnet 4.6',
  'claude-3-haiku-20240307': 'Claude 3 Haiku',
  'claude-haiku-4-5-20251001': 'Claude Haiku 4.5',
  'gpt-5.4-mini': 'GPT-5.4 mini',
  'gpt-5.4': 'GPT-5.4',
  'gpt-5.3-codex': 'GPT-5.3 Codex',
  'gpt-5.2-codex': 'GPT-5.2 Codex',
  'gpt-5.2': 'GPT-5.2',
  'gpt-5.1-codex-max': 'GPT-5.1 Codex Max',
  'gpt-5.1-codex-mini': 'GPT-5.1 Codex mini',
  'gpt-5.3-codex-spark': 'GPT-5.3 Codex Spark',
};

function readCache(): HermesModelCache | null {
  const cachePath = path.join(os.homedir(), '.hermes', 'models_dev_cache.json');
  try {
    const raw = fs.readFileSync(cachePath, 'utf8');
    return JSON.parse(raw) as HermesModelCache;
  } catch {
    return null;
  }
}

function itemLabel(modelId: string, record?: HermesModelRecord): string {
  const label = record?.name?.trim();
  return label || FALLBACK_LABELS[modelId] || modelId;
}

function buildGroup(
  group: string,
  commandPrefix: string,
  ids: readonly string[],
  models?: Record<string, HermesModelRecord>,
): ModelMenuGroup {
  const hasCache = !!models && Object.keys(models).length > 0;
  const selectedIds = hasCache ? ids.filter((id) => models[id]) : [...ids];
  return {
    group,
    items: (selectedIds.length > 0 ? selectedIds : [...ids]).map((id) => ({
      id,
      label: itemLabel(id, models?.[id]),
      command: `${commandPrefix}:${id}`,
    })),
  };
}

export function loadHermesModelGroups(): ModelMenuGroup[] {
  const cache = readCache();
  const anthropic = cache?.anthropic?.models;
  const openai = cache?.openai?.models;

  return [
    buildGroup('Anthropic', 'anthropic', ANTHROPIC_MODEL_IDS, anthropic),
    buildGroup('OpenAI Codex', 'openai-codex', OPENAI_CODEX_MODEL_IDS, openai),
  ];
}
