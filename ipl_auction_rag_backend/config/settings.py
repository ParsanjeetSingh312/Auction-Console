from functools import lru_cache
from pathlib import Path
from pydantic_settings import BaseSettings

class Settings(BaseSettings):
    # --- Paths ---
    PROJECT_ROOT: Path = Path(__file__).resolve().parent.parent
    EXCEL_FILE_PATH: str = str(Path(__file__).resolve().parent.parent.parent / "IPL AUCTION DATA.xlsx")
    SQLITE_DB_PATH: str = str(Path(__file__).resolve().parent.parent / "data" / "database" / "ipl_auction.db")
    CHROMA_DB_PATH: str = str(Path(__file__).resolve().parent.parent / "data" / "database" / "chroma_db")
    
    # --- Embedding Model (runs locally on CPU) ---
    EMBEDDING_MODEL_NAME: str = "BAAI/bge-small-en-v1.5"
    
    # --- Reranker Model (runs locally on CPU) ---
    RERANKER_MODEL_NAME: str = "BAAI/bge-reranker-large"
    
    # --- LLM provider ---
    # "auto" picks whichever key is present, preferring Gemini when both are.
    # Set to "gemini" or "groq" to pin it.
    LLM_PROVIDER: str = "auto"

    # --- Google Gemini ---
    # A single model serves routing, text-to-SQL and synthesis; 2.5 Flash is
    # fast and cheap enough that splitting them buys nothing.
    GEMINI_API_KEY: str = ""
    GEMINI_MODEL: str = "gemini-2.5-flash"

    # --- LLM Models & Dedicated API Keys ---
    # Master Groq key (used as default for any unset model keys)
    GROQ_API_KEY: str = ""
    
    # Model-specific API keys (optional: enter individually or leave blank to inherit GROQ_API_KEY)
    TEXT_TO_SQL_API_KEY: str = ""       # Dedicated key for Qwen / SQL model
    RAG_SYNTHESIS_API_KEY: str = ""     # Dedicated key for Llama RAG synthesis
    QUERY_ROUTER_API_KEY: str = ""      # Dedicated key for query routing
    HUGGINGFACE_API_KEY: str = ""       # Optional Hugging Face Hub token
    
    # Model Names
    RAG_LLM_MODEL: str = "llama-3.1-8b-instant"      # For RAG synthesis
    SQL_LLM_MODEL: str = "llama-3.3-70b-versatile"   # For Text-to-SQL
    ROUTER_LLM_MODEL: str = "llama-3.1-8b-instant"   # For intent classification
    
    # Local Inference Option (Ollama)
    OLLAMA_BASE_URL: str = "http://localhost:11434"
    USE_OLLAMA: bool = False
    
    # --- API Config ---
    API_HOST: str = "0.0.0.0"
    API_PORT: int = 8001
    CORS_ORIGINS: str = "http://localhost:5173,http://localhost:8000,http://localhost:8001"
    
    # --- Retrieval Config ---
    VECTOR_SEARCH_TOP_K: int = 20
    RERANK_TOP_K: int = 5
    
    model_config = {'env_file': '.env', 'env_file_encoding': 'utf-8', 'extra': 'ignore'}

    @property
    def effective_sql_key(self) -> str:
        """Returns dedicated SQL key or falls back to master key."""
        return self.TEXT_TO_SQL_API_KEY or self.GROQ_API_KEY

    @property
    def effective_rag_key(self) -> str:
        """Returns dedicated RAG key or falls back to master key."""
        return self.RAG_SYNTHESIS_API_KEY or self.GROQ_API_KEY

    @property
    def effective_router_key(self) -> str:
        """Returns dedicated Router key or falls back to master key."""
        return self.QUERY_ROUTER_API_KEY or self.GROQ_API_KEY

@lru_cache()
def get_settings() -> Settings:
    return Settings()
