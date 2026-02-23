import os
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
        time.sleep(1.5) 
        
        langfuse_host = os.getenv("LANGFUSE_HOST", "https://cloud.langfuse.com").rstrip("/")
        public_key = os.getenv("LANGFUSE_PUBLIC_KEY")
        secret_key = os.getenv("LANGFUSE_SECRET_KEY")
        
        # Langfuse REST API를 호출하여 해당 트레이스의 '모든 세부 정보'를 요청합니다.
        api_url = f"{langfuse_host}/api/public/traces/{trace_id}"
        api_response = requests.get(api_url, auth=(public_key, secret_key))
        
        if api_response.status_code == 200:
            full_trace_data = api_response.json()
            
            # full_trace_data 안에는 "observations"라는 배열이 있으며, 
            # 여기에 LLM 호출, Tool 검색, 코드 실행 등 모든 하위 span이 들어있습니다.
            base_log_dir = "/app/logs" # 또는 "/app/data/reasoning_dataset"
            
            # ==============================================================
            # 1. 원본 데이터 (Raw Data) 전용 폴더 및 저장
            # ==============================================================
            raw_dir = os.path.join(base_log_dir, "raw")
            os.makedirs(raw_dir, exist_ok=True)
            
            raw_data = {
                "trace_id": trace_id,
                "timestamp": datetime.now().isoformat(),
                "instruction": request.message,
                "langfuse_full_trace": full_trace_data, 
                "final_answer": str(response_content)
            }
            
            # 파일명은 깔끔하게 통일
            raw_file_path = os.path.join(raw_dir, f"trace_{trace_id}.json")
            with open(raw_file_path, "w", encoding="utf-8") as f:
                json.dump(raw_data, f, ensure_ascii=False, indent=4)
                
            # ==============================================================
            # 2. 파인튜닝용 정제 데이터 (Agent Training Format - ChatML/ShareGPT)
            # ==============================================================
            refined_dir = os.path.join(base_log_dir, "refined")
            os.makedirs(refined_dir, exist_ok=True)
            
            observations = full_trace_data.get("observations", [])
            observations.sort(key=lambda x: x.get("startTime", ""))
            
            # 학습 표준 포맷인 messages 배열 생성
            messages = [
                {"role": "system", "content": "You are Biomni-R0, an advanced reasoning and acting agent. Use <execute> to run python code and gather data. Use <solution> to provide the final answer."},
                {"role": "user", "content": request.message}
            ]
            
            for obs in observations:
                obs_type = obs.get("type")
                name = obs.get("name", "")
                output = obs.get("output")
                
                if not output:
                    continue
                
                output_text = str(output)
                if isinstance(output, dict) and "content" in output:
                    output_text = str(output["content"])
                
                # 1. 모델이 직접 생성한 텍스트 (생각 + <execute> 또는 <solution>)
                if obs_type == "GENERATION":
                    # 중복 방지를 위해 마지막 메시지가 assistant가 아닐 때만 추가
                    if messages[-1]["role"] != "assistant":
                        messages.append({"role": "assistant", "content": output_text.strip()})
                
                # 2. 파이썬 샌드박스가 실행한 결과 (Observation)
                elif obs_type == "SPAN" and ("Run" in name or "Tool" in name or "execute" in name.lower()):
                    messages.append({
                        "role": "tool",  # 프레임워크에 따라 "user" 또는 "observation"으로 변경 가능
                        "content": f"Observation:\n{output_text.strip()}"
                    })

            refined_data = {
                "trace_id": trace_id,
                "messages": messages
            }
            
            refined_file_path = os.path.join(refined_dir, f"trace_{trace_id}.json")
            with open(refined_file_path, "w", encoding="utf-8") as f:
                json.dump(refined_data, f, ensure_ascii=False, indent=4)
                
            logger.info(f"✅ Saved trace data to {raw_dir} and {refined_dir}")
        else:
            logger.error(f"Failed to fetch trace from Langfuse: {api_response.text}")

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