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
    refined_data: Dict[str, Any] = {}

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
            
            base_log_dir = "/app/logs"
            
            # ==============================================================
            # 1. 원본 데이터 (Raw Data) 저장
            # ==============================================================
            raw_dir = os.path.join(base_log_dir, "raw")
            os.makedirs(raw_dir, exist_ok=True)
            
            raw_data = {
                "trace_id": trace_id,
                "timestamp": datetime.now().isoformat(),
                "instruction": request.message,
                "langfuse_full_trace": full_trace_data, 
                "response_log": response_log,
                "final_answer": str(response_content)
            }
            
            # raw_file_path = os.path.join(raw_dir, f"trace_{trace_id}.json")
            # with open(raw_file_path, "w", encoding="utf-8") as f:
            #     json.dump(raw_data, f, ensure_ascii=False, indent=4)
                
            # ==============================================================
            # 2. 파인튜닝용 정제 데이터 (Refined Data) - Langfuse Observation 직접 파싱
            # ==============================================================
            
            refined_dir = os.path.join(base_log_dir, "refined")
            os.makedirs(refined_dir, exist_ok=True)
            
            def clean_think(text):
                if not text: return ""
                text = re.sub(r"<think>", "", text)
                text = re.sub(r"</think>", "", text)
                return text.strip()

            # 🌟 [신규] Trace 데이터 전체를 뒤져서 '원본 시스템 프롬프트'를 동적으로 완벽 추출합니다 (하드코딩 제로)
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
            
            # 1. System Message 동적 세팅
            extracted_sys_content = find_system_content(full_trace_data)
            if extracted_sys_content:
                # 추출된 원본 시스템 프롬프트가 존재하면 그대로 쓰고, R1 파인튜닝용 <think> 지시문만 끝에 추가
                if "<think>" not in extracted_sys_content:
                    sys_content = extracted_sys_content + "\n\nUse <think>...</think> tags to show your step-by-step reasoning process before acting."
                else:
                    sys_content = extracted_sys_content
            else:
                # 만약의 경우를 대비한 최소한의 Fallback (추출 실패 시)
                sys_content = "You are Biomni, an advanced reasoning and acting agent. Use <think>...</think> tags to show your step-by-step reasoning process before acting."

            messages.append({
                "id": None, "name": None, "type": "system", "content": sys_content,
                "additional_kwargs": {}, "response_metadata": {}
            })
            
            # 2. Human Message 세팅
            messages.append({
                "id": None, "name": None, "type": "human", "content": request.message,
                "additional_kwargs": {}, "response_metadata": {}
            })

            # 3. Langfuse REST API로 받아온 확정 데이터를 파싱 (메모리 휘발 방지)
            observations = full_trace_data.get("observations", [])
            observations.sort(key=lambda x: x.get("startTime", "")) 
            
            think_steps = []
            seen_contents = set()
            clean_final = clean_think(str(response_content)).strip()
            
            # 🌟 [추가된 부분] 두 가지 내용을 명시적으로 저장할 빈 리스트 생성
            llm_thoughts = [] 
            tool_results = []
            
            for obs in observations:
                obs_type = obs.get("type")
                name = obs.get("name", "")
                
                if name == "Biomni Chat Interaction":
                    continue
                    
                output = obs.get("output")
                if not output:
                    continue
                    
                content = ""
                if isinstance(output, dict):
                    if "kwargs" in output and "content" in output["kwargs"]:
                        content = str(output["kwargs"].get("content", ""))
                    elif "content" in output:
                        content = str(output.get("content", ""))
                    else:
                        content = json.dumps(output, ensure_ascii=False)
                else:
                    content = str(output)
                    
                clean_content = clean_think(content)
                if not clean_content.strip():
                    continue
                    
                if clean_content in seen_contents:
                    continue
                seen_contents.add(clean_content)
                
                if clean_content == clean_final:
                    continue
                
                # 🌟 [수정된 부분] GENERATION(생각)과 SPAN(도구 실행) 분리 및 별도 저장
                if obs_type == "GENERATION":
                    think_steps.append(clean_content)
                    llm_thoughts.append(clean_content)  # LLM의 생각 과정 저장
                    
                elif obs_type == "SPAN":
                    # 도구에 들어간 입력값(Input)도 함께 추출 (추적에 매우 유용함)
                    obs_input = obs.get("input", "")
                    
                    # Tool 실행 내역 저장 (이름, 입력값, 결과값)
                    tool_results.append({
                        "tool_name": name,
                        "tool_input": obs_input,
                        "tool_output": clean_content
                    })
                    
                    if "feedback" in name.lower() or "error" in name.lower():
                        think_steps.append(f"System Feedback:\n{clean_content}")
                    else:
                        # R1 스타일 프롬프트에도 Tool 이름이 명시되도록 개선
                        think_steps.append(f"Action (Tool: {name}):\nInput: {obs_input}\nObservation:\n{clean_content}")

            # 4. DeepSeek R1 스타일 조립
            combined_think = "\n\n".join(think_steps)
            if combined_think.strip():
                deepseek_content = f"<think>\n{combined_think}\n</think>\n\n{clean_final}"
            else:
                deepseek_content = clean_final
                
            messages.append({
                "id": None, "name": None, "type": "ai", "content": deepseek_content,
                "tool_calls": [], "invalid_tool_calls": [], "usage_metadata": None,
                "additional_kwargs": {}, "response_metadata": {}
            })

            # 🌟 [수정된 부분] refined_data 구조에 추출한 두 가지 리스트 추가
            refined_data = {
                "trace_id": trace_id,
                "final_answer": str(response_content),
                "messages": messages,
                "llm_thoughts": llm_thoughts,  # LLM이 생각한 과정 배열
                "tool_results": tool_results   # 각 도구의 이름/입력/결과 배열
            }
            
            # (선택 사항) 만약 이 정제된 데이터를 실제 JSON 파일로 저장하고 싶으시다면 
            # 아래 주석 처리된 코드를 해제(Uncomment)해 주세요.
            # refined_file_path = os.path.join(refined_dir, f"trace_{trace_id}.json")
            # with open(refined_file_path, "w", encoding="utf-8") as f:
            #     json.dump(refined_data, f, ensure_ascii=False, indent=4)
                
            logger.info(f"✅ Saved raw and refined trace data (DeepSeek R1 style) to {base_log_dir}")

        # 5. [수정됨] 로그를 포함하여 반환
        return {
            "response": str(response_content),
            "logs": response_log, # 프론트엔드에서 중간 과정을 시각화하기 위해 필수
            "refined_data": refined_data if 'refined_data' in locals() else {}
        }
    
    except Exception as e:
        logger.error(f"Error during execution: {e}")
        langfuse_context.update_current_trace(level="ERROR", status_message=str(e))
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    import uvicorn
    # app 대신 "main:app" 문자열로 넣고, reload=True를 추가합니다.
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)