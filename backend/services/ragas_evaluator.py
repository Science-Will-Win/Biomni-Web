import logging
import asyncio
from typing import List, Dict, Any
from datasets import Dataset
from ragas import evaluate
from ragas.metrics import faithfulness, answer_relevance

from services.llm_service import get_llm_service
from services.conversation_service import ConversationService
from db.database import SessionLocal

# 로거 설정
logger = logging.getLogger("biomni_backend.ragas_evaluator")

async def evaluate_and_log(
    question: str, 
    answer: str, 
    contexts: List[str], 
    conv_id: str
) -> Dict[str, float]:
    """
    Ragas를 사용하여 에이전트 응답 품질을 비동기로 평가하고 결과를 기록합니다.
    
    Args:
        question: 유저의 질문 (Query)
        answer: 에이전트의 최종 응답 (Response)
        contexts: Neo4j에서 추출하여 프롬프트에 주입했던 지식 리스트 (Retrieved Insights)
        conv_id: 해당 대화의 세션 ID
    """
    try:
        logger.info(f"Starting Ragas evaluation for session: {conv_id}")

        # 1. 프로젝트 내부 LLM 서비스 인스턴스 확보
        llm_svc = get_llm_service()
        # Ragas 평가를 위한 LangChain 호환 LLM 객체 생성 (기본 모델 사용)
        async with SessionLocal() as db:
            eval_llm = await llm_svc.get_llm_instance(db=db)
        
        # 2. Ragas 입력용 데이터셋 구성 (단일 샘플)
        data_dict = {
            "question": [question],
            "answer": [answer],
            "contexts": [contexts],
        }
        dataset = Dataset.from_dict(data_dict)

        # 3. Ragas 평가 실행 (Faithfulness, Answer Relevance)
        # 루프 내부에서 실행될 경우 블로킹을 방지하기 위해 thread pool에서 실행하거나 
        # Ragas의 비동기 지원 기능을 활용합니다.
        result = evaluate(
            dataset,
            metrics=[faithfulness, answer_relevance],
            llm=eval_llm,
            embeddings=None # 필요 시 임베딩 모델 추가 가능
        )

        # 4. 결과 추출
        scores = {
            "faithfulness": float(result["faithfulness"]),
            "answer_relevance": float(result["answer_relevance"])
        }

        # 5. 결과 기록 (로그 및 DB)
        logger.info(f"Ragas evaluation completed for {conv_id}: {scores}")
        
        # [참고] DB에 점수를 영구 저장하고 싶다면 ConversationService에 메서드를 추가하여 호출하세요.
        # 예: await conv_svc.save_eval_scores(conv_id, scores)
        
        return scores

    except Exception as e:
        logger.error(f"Ragas evaluation failed for session {conv_id}: {str(e)}")
        return {"error": 0.0}

# [참고] 이 함수는 chat_handler.py에서 background_tasks.add_task() 
# 또는 asyncio.create_task()를 통해 비동기로 호출됩니다.