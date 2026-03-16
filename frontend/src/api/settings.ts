import { fetchJSON } from './client';
import type {
  SettingsResponse,
  SettingsUpdateRequest,
  SystemPromptResponse,
  StatusResponse,
} from '@/types';

export async function getSettings(): Promise<SettingsResponse> {
  return fetchJSON('/api/settings');
}

export async function updateSettings(body: SettingsUpdateRequest): Promise<StatusResponse> {
  return fetchJSON('/api/settings', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function getSystemPrompt(signal?: AbortSignal): Promise<SystemPromptResponse> {
  return fetchJSON('/api/system_prompt', signal ? { signal } : undefined);
}

export async function getDefaultSystemPrompt(): Promise<SystemPromptResponse> {
  return fetchJSON('/api/system_prompt/default');
}

export async function setSystemPrompt(prompt: string): Promise<StatusResponse> {
  return fetchJSON('/api/system_prompt', {
    method: 'POST',
    body: JSON.stringify({ prompt }),
  });
}

export interface PromptSection {
  label: string;
  content: string;
}

export interface ComposedPromptData {
  composed: string;
  sections: PromptSection[];
  custom: string;
}

export interface ComposedPromptsResponse {
  full: ComposedPromptData;
  agent: ComposedPromptData;
  plan: ComposedPromptData;
}

export async function getComposedPrompts(): Promise<ComposedPromptsResponse> {
  return fetchJSON('/api/system_prompt/composed');
}

export async function saveComposedPrompt(mode: string, prompt: string): Promise<StatusResponse> {
  return fetchJSON('/api/system_prompt/composed', {
    method: 'POST',
    body: JSON.stringify({ mode, prompt }),
  });
}
