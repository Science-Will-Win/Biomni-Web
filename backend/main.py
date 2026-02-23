import os
import re
import sys
import logging
import json
import uuid
import time
import requests
from datetime import datetime
from typing import Optional, List, Any, Dict
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from dotenv import load_dotenv

# [로컬 개발용] 상위 폴더(.env)의 환경변수 로드
# Docker에서는 env_file로 주입되지만, 로컬 실행 시 필요합니다.
load_dotenv(dotenv_path="../.env")

# --- [Monkey Patching: 호환성 해결] ---
import langchain_core.callbacks
import langchain_core.callbacks.base
import langchain_core.agents
import langchain_core.documents
import langchain_core.messages
import langchain_core.outputs

sys.modules["langchain.callbacks"] = langchain_core.callbacks
sys.modules["langchain.callbacks.base"] = langchain_core.callbacks.base
sys.modules["langchain.schema"] = langchain_core.messages 
sys.modules["langchain.schema.agent"] = langchain_core.agents
sys.modules["langchain.schema.document"] = langchain_core.documents

# [Langfuse & LangChain Integrations]
from langchain_core.messages import SystemMessage, HumanMessage
from langfuse.decorators import observe, langfuse_context
from langfuse.callback import CallbackHandler

# --- [Biomni Import] ---
from biomni.agent.a1 import A1

load_dotenv(dotenv_path="../.env")

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("BiomniWeb")

app = FastAPI()

# 1. 정적 파일 서빙 추가 (생성된 이미지/PDF 접근용)
# Docker volume 매핑에 맞춰 경로 설정 (컨테이너 내부 경로: /app/data)
if os.path.exists("/app/data"):
    app.mount("/data", StaticFiles(directory="/app/data"), name="data")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

agent: Optional[A1] = None

def initialize_agent():
    global agent
    logger.info("Initializing Biomni Agent...")
    try:
        # Docker 환경 변수 우선, 없으면 로컬 경로
        data_path = os.getenv("BIOMNI_DATA_PATH", "../biomni_data")
        agent = A1(path=data_path)
        logger.info("Biomni Agent initialized successfully.")
    except Exception as e:
        logger.error(f"Failed to initialize Biomni Agent: {e}")
        agent = None

initialize_agent()

class ChatRequest(BaseModel):
    message: str

# 응답 모델 정의 (로그 포함)
class ChatResponse(BaseModel):
    response: str
    logs: List[Any]  # Biomni의 response_log 구조에 따라 유연하게 설정

@app.post("/api/chat", response_model=ChatResponse)
@observe(name="Biomni Chat Interaction")
async def chat_endpoint(request: ChatRequest):
    if not agent:
        # 재시도 로직 (필요시)
        initialize_agent()
        if not agent:
            raise HTTPException(status_code=500, detail="Agent not initialized")
    
    logger.info(f"Received request: {request.message}")
    
    try:
        # ... (기존 Monkey Patching 로직 그대로 유지) ...
        # (original_stream, traced_stream 정의 부분)

        # agent.app.stream = traced_stream 
        
        # 4. 에이전트 실행
        langfuse_handler = langfuse_context.get_current_langchain_handler()
        response_log, response_content = agent.go(request.message, callbacks=[langfuse_handler])
        
        # agent.app.stream = original_stream
        
        # Langfuse 업데이트
        langfuse_context.update_current_trace(
            output=str(response_content),
            metadata={"full_log_length": len(response_log)}
        )

        # 🌟 매우 중요: 백그라운드에서 수집 중인 모든 하위 Span들을 서버로 강제 전송 완료시킵니다.
        langfuse_context.flush()

        trace_id = langfuse_context.get_current_trace_id()
        
        # Langfuse 서버의 DB에 하위 Span들이 완전히 기록될 때까지 아주 잠깐(1~2초) 대기합니다.
        time.sleep(3) 
        
        langfuse_host = os.getenv("LANGFUSE_HOST", "https://cloud.langfuse.com").rstrip("/")
        public_key = os.getenv("LANGFUSE_PUBLIC_KEY")
        secret_key = os.getenv("LANGFUSE_SECRET_KEY")
        
        # Langfuse REST API를 호출하여 해당 트레이스의 '모든 세부 정보'를 요청합니다.
        api_url = f"{langfuse_host}/api/public/traces/{trace_id}"
        api_response = requests.get(api_url, auth=(public_key, secret_key))
        
        if api_response.status_code == 200:
            full_trace_data = api_response.json()
            
            base_log_dir = "/app/logs" # 또는 "/app/data/reasoning_dataset"
            
            # ==============================================================
            # 1. 원본 데이터 (Raw Data) 저장
            # ==============================================================
            refined_dir = os.path.join(base_log_dir, "refined")
            os.makedirs(refined_dir, exist_ok=True)
            
            # LangChain 객체에서 딕셔너리를 완벽하게 추출하는 함수
            def dump_msg(obj):
                if isinstance(obj, dict): return dict(obj)
                d = {}
                if hasattr(obj, "dict") and callable(obj.dict):
                    try: d.update(obj.dict())
                    except: pass
                elif hasattr(obj, "__dict__"):
                    try: d.update(vars(obj))
                    except: pass
                for attr in ["id", "name", "type", "content", "tool_calls", "invalid_tool_calls", "response_metadata", "additional_kwargs", "usage_metadata"]:
                    if hasattr(obj, attr):
                        val = getattr(obj, attr)
                        if not callable(val): d[attr] = val
                return d

            def clean_think(text):
                if not text: return ""
                text = re.sub(r"<think>", "", text)
                text = re.sub(r"</think>", "", text)
                return text.strip()

            clean_final = clean_think(str(response_content)).strip()
            
            # 💡 [핵심] 텍스트 쪼가리인 response_log 대신, a1.py에 저장된 '실제 원본 상태 객체'를 가져옵니다.
            raw_msgs = []
            if hasattr(agent, "_conversation_state") and agent._conversation_state:
                state_msgs = agent._conversation_state.get("messages", [])
                for m in state_msgs:
                    raw_msgs.append(dump_msg(m))
            
            messages = []
            seen_contents = set()
            
            for m_dict in raw_msgs:
                m_type = m_dict.get("type", "")
                
                # 1. System Message (think 프롬프트 추가)
                if m_type == "system":
                    m_dict["content"] = "You are Biomni-R0, an advanced reasoning and acting agent. Use <think>...</think> tags to show your step-by-step reasoning process before acting. Use <execute> to run python code and gather data. Use <solution> to provide the final answer."
                    messages.append(m_dict)
                    continue
                    
                # 2. Human Message
                if m_type == "human":
                    messages.append(m_dict)
                    continue
                
                # 3. AI 및 Tool 메시지 처리
                if m_type not in ["ai", "ai_message", "tool", "tool_message"]:
                    continue
                    
                # 타입명 통일
                if m_type == "ai_message": m_dict["type"] = "ai"
                if m_type == "tool_message": m_dict["type"] = "tool"
                m_type = m_dict["type"]
                
                content = str(m_dict.get("content", "") or "")
                
                if not content.strip():
                    messages.append(m_dict)
                    continue
                    
                clean_content = clean_think(content)
                
                if m_type == "tool":
                    m_dict["content"] = clean_content
                    messages.append(m_dict)
                    continue
                    
                if m_type == "ai":
                    # 중복 답변 차단
                    if clean_content and clean_content in seen_contents:
                        continue
                    if clean_content:
                        seen_contents.add(clean_content)
                        
                    # 최종 답변(final_answer)과 완전히 동일한 경우 think로 감싸지 않음
                    if clean_content == clean_final:
                        m_dict["content"] = clean_content
                    else:
                        # 중간 추론 과정은 전체를 <think>로 예쁘게 감싸기
                        if clean_content.strip():
                            m_dict["content"] = f"<think>\n{clean_content}\n</think>"
                        else:
                            m_dict["content"] = ""
                            
                    messages.append(m_dict)

            refined_data = {
                "trace_id": trace_id,
                "messages": messages
            }
            
            refined_file_path = os.path.join(refined_dir, f"trace_{trace_id}.json")
            with open(refined_file_path, "w", encoding="utf-8") as f:
                json.dump(refined_data, f, ensure_ascii=False, indent=4)
                
            logger.info(f"✅ Saved raw and refined trace data to {base_log_dir} (Trace ID: {trace_id})")

        # 5. [수정됨] 로그를 포함하여 반환
        return {
            "response": str(response_content),
            "logs": response_log # 프론트엔드에서 중간 과정을 시각화하기 위해 필수
        }
    
    except Exception as e:
        logger.error(f"Error during execution: {e}")
        langfuse_context.update_current_trace(level="ERROR", status_message=str(e))
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    import uvicorn
    # app 대신 "main:app" 문자열로 넣고, reload=True를 추가합니다.
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)