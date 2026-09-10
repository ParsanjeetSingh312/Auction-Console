"""
chroma_manager.py
ChromaDB vector store manager for semantic search over player profiles.
Uses the BGE embedding model for dense vector representations.
"""
import logging
from pathlib import Path
from typing import Any

import chromadb
from chromadb.config import Settings as ChromaSettings

from config.settings import get_settings
from models.embedding_loader import get_embedding_model

logger = logging.getLogger(__name__)

COLLECTION_NAME = "ipl_players"


class ChromaManager:
    """Manages the ChromaDB vector store for player profile embeddings."""
    
    def __init__(self, persist_dir: str | None = None):
        self.persist_dir = persist_dir or get_settings().CHROMA_DB_PATH
        Path(self.persist_dir).mkdir(parents=True, exist_ok=True)
        
        self._client = chromadb.PersistentClient(
            path=self.persist_dir,
            settings=ChromaSettings(
                anonymized_telemetry=False,
                allow_reset=True,
            ),
        )
        self._embedding_model = get_embedding_model()
        self._collection = None
    
    @property
    def collection(self) -> chromadb.Collection:
        """Get or create the player embeddings collection."""
        if self._collection is None:
            self._collection = self._client.get_or_create_collection(
                name=COLLECTION_NAME,
                metadata={"hnsw:space": "cosine"},
            )
        return self._collection
    
    def add_documents(
        self,
        texts: list[str],
        metadatas: list[dict[str, Any]],
        ids: list[str],
    ) -> int:
        """
        Add player text summaries with embeddings to ChromaDB.
        
        Args:
            texts: Synthetic text summaries for each player.
            metadatas: Metadata dicts (role, cap_status, overseas, etc.).
            ids: Unique document IDs (e.g., "player_1", "player_2").
        
        Returns:
            Number of documents added.
        """
        # Generate embeddings using the BGE model
        embeddings = self._embedding_model.embed_documents(texts)
        
        # Upsert in batches of 100 to avoid memory issues
        batch_size = 100
        for i in range(0, len(texts), batch_size):
            end = min(i + batch_size, len(texts))
            self.collection.upsert(
                ids=ids[i:end],
                embeddings=embeddings[i:end],
                documents=texts[i:end],
                metadatas=metadatas[i:end],
            )
        
        logger.info("Added %d documents to ChromaDB collection '%s'", len(texts), COLLECTION_NAME)
        return len(texts)
    
    def similarity_search(
        self,
        query: str,
        n_results: int = 20,
        where_filter: dict[str, Any] | None = None,
    ) -> list[dict[str, Any]]:
        """
        Perform similarity search over the player embeddings.
        
        Args:
            query: The user's search query text.
            n_results: Number of nearest neighbors to return.
            where_filter: Optional ChromaDB metadata filter, e.g.
                {"role": "Batsman"} or {"$and": [{"role": "Bowler"}, {"overseas": 1}]}
        
        Returns:
            List of result dicts with keys: id, text, metadata, distance.
        """
        query_embedding = self._embedding_model.embed_query(query)
        
        search_kwargs: dict[str, Any] = {
            "query_embeddings": [query_embedding],
            "n_results": min(n_results, self.collection.count() or n_results),
        }
        if where_filter:
            search_kwargs["where"] = where_filter
        
        results = self.collection.query(**search_kwargs)
        
        # Flatten ChromaDB's nested result format
        documents = []
        if results and results["ids"] and results["ids"][0]:
            for i in range(len(results["ids"][0])):
                documents.append({
                    "id": results["ids"][0][i],
                    "text": results["documents"][0][i] if results["documents"] else "",
                    "metadata": results["metadatas"][0][i] if results["metadatas"] else {},
                    "distance": results["distances"][0][i] if results["distances"] else 0.0,
                })
        
        return documents
    
    def reset_collection(self) -> None:
        """Delete and recreate the collection (used during re-ingestion)."""
        try:
            self._client.delete_collection(COLLECTION_NAME)
        except Exception:
            pass
        self._collection = None
        logger.info("ChromaDB collection '%s' reset", COLLECTION_NAME)
    
    def get_document_count(self) -> int:
        """Return the number of documents in the collection."""
        return self.collection.count()
