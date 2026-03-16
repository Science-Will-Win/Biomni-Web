import React from 'react';

// 어떤 데이터를 받을지 타입(Props)을 정의해 줍니다.
interface MarkdownContentProps {
  content?: string; // 마크다운 텍스트 원본이 들어올 자리
}

export const MarkdownContent: React.FC<MarkdownContentProps> = ({ content }) => {
  // 내용이 없을 때 보여줄 기본 화면
  if (!content) {
    return <div className="text-gray-500">마크다운 내용이 없습니다.</div>;
  }

  // 내용이 있을 때 보여줄 화면 (일단은 단순 텍스트로 렌더링)
  return (
    <div className="markdown-container p-4 bg-gray-50 rounded-md">
      {/* 나중에는 여기에 진짜 마크다운 렌더링 라이브러리를 적용하면 돼! */}
      <pre className="whitespace-pre-wrap font-sans">{content}</pre>
    </div>
  );
};