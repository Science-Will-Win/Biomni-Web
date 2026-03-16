/**
 * Static model registry — fallback when backend API is unreachable.
 * Keep in sync with backend/model_registry.yaml.
 */
import type { ModelInfo } from '@/types';

export const MODEL_REGISTRY: ModelInfo[] = [
  // Local Models — only models with physical folders show up from backend
  { name: 'ministral-reasoning', display_name: 'Ministral-3-3B-Reasoning-2512', type: 'local', provider: 'vllm', status: 'unavailable' },
  // Cloud API Models
  { name: 'gpt-4o', display_name: 'GPT-4o', type: 'api', provider: 'openai', status: 'no_api_key' },
  { name: 'gpt-4o-mini', display_name: 'GPT-4o Mini', type: 'api', provider: 'openai', status: 'no_api_key' },
  { name: 'claude-sonnet-4-5', display_name: 'Claude Sonnet 4.5', type: 'api', provider: 'anthropic', status: 'no_api_key' },
  { name: 'claude-haiku-4-5', display_name: 'Claude Haiku 4.5', type: 'api', provider: 'anthropic', status: 'no_api_key' },
  { name: 'gemini-2.0-flash', display_name: 'Gemini 2.0 Flash', type: 'api', provider: 'gemini', status: 'no_api_key' },
  { name: 'gemini-2.5-pro', display_name: 'Gemini 2.5 Pro', type: 'api', provider: 'gemini', status: 'no_api_key' },
];
