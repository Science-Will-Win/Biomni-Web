// src/utils/codeHighlight.ts

/**
 * 코드를 받아서 문법 하이라이팅(색상 입히기) 처리를 해주는 유틸리티 함수입니다.
 * 현재는 임시 뼈대이므로 입력받은 코드를 그대로 반환합니다.
 */
export const highlightCodeSyntax = (code: string, language?: string): string => {
  // 에러 방지용으로 빈 문자열 처리
  if (!code) return "";
  
  // 나중에는 여기에 진짜 하이라이팅 로직을 추가하면 돼!
  return code;
};