"""
reranker_loader.py
Singleton loader for the BAAI/bge-reranker-large cross-encoder model.
Runs locally on CPU at $0 cost. Used to rescore top-20 vector search
candidates down to top-5 highest precision matches.
"""
import logging
from functools import lru_cache
from dataclasses import dataclass

# Must run before sentence_transformers is imported — see models/hf_runtime.py.
from models.hf_runtime import configure_from_settings

configure_from_settings()

from sentence_transformers import CrossEncoder

from config.settings import get_settings

logger = logging.getLogger(__name__)


@dataclass
class RankedResult:
    """A single re-ranked document with its index and relevance score."""
    index: int
    score: float
    text: str


@lru_cache(maxsize=1)
def get_reranker_model() -> CrossEncoder:
    """
    Load and cache the BGE reranker cross-encoder model.
    The first call downloads the model (~2.2 GB on disk); later calls return the
    cached instance. Loading is deferred until the first query that needs
    reranking, so an agent that only serves the roster never pays for it.
    """
    settings = get_settings()
    logger.info("Loading reranker model: %s", settings.RERANKER_MODEL_NAME)
    
    model = CrossEncoder(
        settings.RERANKER_MODEL_NAME,
        max_length=512,
        device="cpu",
    )
    
    logger.info("Reranker model loaded successfully")
    return model


def rerank(
    query: str,
    documents: list[str],
    top_k: int = 5,
) -> list[RankedResult]:
    """
    Re-rank a list of document texts against a query using the cross-encoder.
    
    Args:
        query: The user's search query.
        documents: List of document text strings to re-rank.
        top_k: Number of top results to return.
    
    Returns:
        List of RankedResult sorted by relevance score (descending).
    """
    if not documents:
        return []
    
    model = get_reranker_model()
    
    # CrossEncoder expects list of [query, document] pairs
    pairs = [[query, doc] for doc in documents]
    scores = model.predict(pairs)
    
    # Create indexed results and sort by score descending
    results = [
        RankedResult(index=i, score=float(score), text=doc)
        for i, (score, doc) in enumerate(zip(scores, documents))
    ]
    results.sort(key=lambda r: r.score, reverse=True)
    
    return results[:top_k]
