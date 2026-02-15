import axios from 'axios';
import { LogStep } from './types';

// 백엔드 주소 (로컬)
const API_BASE_URL = 'http://localhost:8000/api';

interface ChatResponse {
  response: string;
  logs: LogStep[];
}

export const sendMessage = async (message: string): Promise<ChatResponse> => {
  const response = await axios.post<ChatResponse>(`${API_BASE_URL}/chat`, { message });
  return response.data;
};