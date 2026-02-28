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
        data_path = os.getenv("BIOMNI_DATA_PATH", "../biomni_data")
        agent = A1(path=data_path)
        logger.info("Biomni Agent initialized successfully.")
    except Exception as e:
        logger.error(f"Failed to initialize Biomni Agent: {e}")
        agent = None

initialize_agent()

class ChatRequest(BaseModel):
    message: str

class ChatResponse(BaseModel):
    response: str
    logs: List[Any]
    raw_data: List[Any] = []  # 원본 로그 데이터를 담을 필드 추가
    refined_data: Dict[str, Any] = {}

def sanitize_for_json(obj):
    """복잡한 AI 객체를 JSON으로 변환 가능한 기본 타입으로 분해하는 함수"""
    if isinstance(obj, dict):
        return {str(k): sanitize_for_json(v) for k, v in obj.items()}
    elif isinstance(obj, (list, tuple, set)):
        return [sanitize_for_json(i) for i in obj]
    elif hasattr(obj, "dict") and callable(getattr(obj, "dict")):
        try: return sanitize_for_json(obj.dict())
        except: pass
    elif hasattr(obj, "model_dump") and callable(getattr(obj, "model_dump")):
        try: return sanitize_for_json(obj.model_dump())
        except: pass
    elif isinstance(obj, (str, int, float, bool, type(None))):
        return obj
    return str(obj) # 변환할 수 없는 객체는 문자열로 강제 변환하여 에러 방지

@app.post("/api/chat", response_model=ChatResponse)
@observe(name="Biomni Chat Interaction")
async def chat_endpoint(request: ChatRequest):
    if not agent:
        initialize_agent()
        if not agent:
            raise HTTPException(status_code=500, detail="Agent not initialized")
    
    logger.info(f"Received request: {request.message}")
    
    try:
        langfuse_handler = langfuse_context.get_current_langchain_handler()
        response_log, response_content = agent.go(request.message, callbacks=[langfuse_handler])
        
        langfuse_context.update_current_trace(
            output=str(response_content),
            metadata={"full_log_length": len(response_log)}
        )

        langfuse_context.flush()
        trace_id = langfuse_context.get_current_trace_id()
        time.sleep(3) 
        
        langfuse_host = os.getenv("LANGFUSE_HOST", "https://cloud.langfuse.com").rstrip("/")
        public_key = os.getenv("LANGFUSE_PUBLIC_KEY")
        secret_key = os.getenv("LANGFUSE_SECRET_KEY")
        
        api_url = f"{langfuse_host}/api/public/traces/{trace_id}"
        api_response = requests.get(api_url, auth=(public_key, secret_key))
        
        if api_response.status_code == 200:
            full_trace_data = api_response.json()
            
            def find_system_content(obj):
                if isinstance(obj, dict):
                    if obj.get("type") in ["system", "system_message"] and "content" in obj:
                        return str(obj["content"])
                    if isinstance(obj.get("id"), list) and obj.get("id") and obj.get("id")[-1] == "SystemMessage":
                        return str(obj.get("kwargs", {}).get("content", ""))
                    if obj.get("role") == "system" and "content" in obj:
                        return str(obj["content"])
                    for k, v in obj.items():
                        res = find_system_content(v)
                        if res: return res
                elif isinstance(obj, (list, tuple)):
                    for item in obj:
                        res = find_system_content(item)
                        if res: return res
                return ""

            messages = []
            
            # 1. System Message (맨 처음에 한 번만)
            extracted_sys_content = find_system_content(full_trace_data)
            sys_content = extracted_sys_content
            messages.append({"type": "system", "content": sys_content})
            
            # 2. LangGraph span 찾기
            observations = full_trace_data.get("observations", [])
            observations.sort(key=lambda x: x.get("startTime", "")) 
            
            langgraph_messages = []
            for obs in observations:
                if obs.get("name", "").lower() == "langgraph":
                    obs_output = obs.get("output", {})
                    if isinstance(obs_output, dict) and "messages" in obs_output:
                        langgraph_messages = obs_output["messages"]
                    elif isinstance(obs.get("input"), dict) and "messages" in obs["input"]:
                        langgraph_messages = obs["input"]["messages"]
                    break
            
            # 3. [핵심] 어떠한 조건 검사나 덮어쓰기 없이, 발생한 턴을 100% 순차적으로 추가!
            for msg in langgraph_messages:
                m_type = msg.get("type", "")
                m_content = msg.get("content", "")
                
                if not m_content:
                    continue
                
                if m_type == "system":
                    # 시스템 프롬프트는 1번 과정에서 이미 넣었으므로 중복 방지를 위해 패스
                    continue
                elif m_type == "human":
                    messages.append({"type": "human", "content": m_content})
                elif m_type == "ai":
                    if m_content.startswith("<observation>"):
                        messages.append({"type": "Result", "content": m_content})
                    else:
                        messages.append({"type": "LLM", "content": m_content})
                else:
                    messages.append({"type": m_type, "content": m_content})

            refined_data = {
                "trace_id": trace_id,
                "final_answer": str(response_content),
                "messages": messages
            }

        safe_logs = sanitize_for_json(response_log)
        return {
            "response": str(response_content),
            "logs": safe_logs,
            "raw_data": safe_logs,  # 중요하다고 하신 원본 로그 데이터
            "refined_data": refined_data if 'refined_data' in locals() else {}
        }
    
    except Exception as e:
        logger.error(f"Error during execution: {e}")
        langfuse_context.update_current_trace(tags=["ERROR"], metadata={"error": str(e)})
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)