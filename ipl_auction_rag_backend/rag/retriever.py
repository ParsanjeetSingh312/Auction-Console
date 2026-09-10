"""
retriever.py
Two-stage hybrid retrieval pipeline:
1. ChromaDB similarity search -> Top-20 candidates
2. BGE cross-encoder reranking -> Top-5 precision results
"""
import logging
from dataclasses import dataclass, field
from typing import Any

from config.settings import get_settings
from db.chroma_manager import ChromaManager
from models.reranker_loader import rerank

logger = logging.getLogger(__name__)


@dataclass
class RetrievedDocument:
    """A retrieved and optionally re-ranked document."""
    id: str
    text: str
    metadata: dict[str, Any] = field(default_factory=dict)
    vector_distance: float = 0.0
    rerank_score: float | None = None


def retrieve(
    query: str,
    top_k: int | None = None,
    use_reranker: bool = True,
    where_filter: dict[str, Any] | None = None,
) -> list[RetrievedDocument]:
    """
    Perform two-stage retrieval:
    1. Fetch Top-K candidates from ChromaDB via dense vector search
    2. Re-rank with cross-encoder for precision (if enabled)
    
    Args:
        query: The user's search query.
        top_k: Number of final results (default from settings).
        use_reranker: Whether to apply cross-encoder reranking.
        where_filter: Optional ChromaDB metadata filter.
    
    Returns:
        List of RetrievedDocument, sorted by relevance.
    """
    settings = get_settings()
    vector_top_k = settings.VECTOR_SEARCH_TOP_K
    final_top_k = top_k or settings.RERANK_TOP_K
    
    # Stage 1: Dense vector search from ChromaDB
    chroma_mgr = ChromaManager()
    raw_results = chroma_mgr.similarity_search(
        query=query,
        n_results=vector_top_k,
        where_filter=where_filter,
    )
    
    if not raw_results:
        logger.info("No vector search results for query: '%s'", query[:80])
        return []
    
    logger.info("Stage 1: Retrieved %d candidates from ChromaDB", len(raw_results))
    
    if not use_reranker or len(raw_results) <= final_top_k:
        # Skip reranking if few results or disabled
        return [
            RetrievedDocument(
                id=r["id"],
                text=r["text"],
                metadata=r["metadata"],
                vector_distance=r["distance"],
            )
            for r in raw_results[:final_top_k]
        ]
    
    # Stage 2: Cross-encoder reranking
    try:
        doc_texts = [r["text"] for r in raw_results]
        reranked = rerank(query=query, documents=doc_texts, top_k=final_top_k)
        
        results = []
        for ranked in reranked:
            original = raw_results[ranked.index]
            results.append(RetrievedDocument(
                id=original["id"],
                text=original["text"],
                metadata=original["metadata"],
                vector_distance=original["distance"],
                rerank_score=ranked.score,
            ))
        
        logger.info("Stage 2: Reranked to top %d results", len(results))
        return results
        
    except Exception as e:
        logger.warning("Reranking failed (%s), returning vector results only", e)
        return [
            RetrievedDocument(
                id=r["id"],
                text=r["text"],
                metadata=r["metadata"],
                vector_distance=r["distance"],
            )
            for r in raw_results[:final_top_k]
        ]
