// 로그 데이터의 구조 정의
export interface LogStep {
  step?: string;
  tool?: string;
  tool_input?: string;
  tool_output?: string;
  thought?: string;
  [key: string]: any;
}

// 채팅 메시지 구조 정의
export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  logs?: LogStep[];
  isLoading?: boolean;
}