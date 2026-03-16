import { fetchJSON } from './client';
import type {
  ModelInfo,
  ModelSwitchRequest,
  ApiKeyRequest,
  ApiKeyInfo,
  StatusResponse,
} from '@/types';

export async function getCurrentModel(): Promise<ModelInfo> {
  return fetchJSON('/api/model');
}

export async function listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
  return fetchJSON('/api/models', signal ? { signal } : undefined);
}

export async function switchModel(modelName: string, signal?: AbortSignal, force?: boolean): Promise<StatusResponse> {
  const body: ModelSwitchRequest = { model_name: modelName, ...(force ? { force: true } : {}) };
  return fetchJSON('/api/model/switch', {
    method: 'POST',
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
}

export async function listApiKeys(): Promise<ApiKeyInfo[]> {
  return fetchJSON('/api/api-keys');
}

export async function setApiKey(provider: string, apiKey: string): Promise<StatusResponse> {
  const body: ApiKeyRequest = { provider, api_key: apiKey };
  return fetchJSON('/api/api-keys', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}
