"""
embedding_loader.py
Singleton loader for the BAAI/bge-small-en-v1.5 embedding model.
Runs locally on CPU at $0 cost. Used by ChromaDB for document embeddings
and query embeddings.
"""
import logging
import warnings
from functools import lru_cache

# Must run before the embedding class is imported: huggingface_hub reads the
# offline and cache variables into module constants at import time, so
# configuring afterwards would have no effect on this process.
from models.hf_runtime import configure_from_settings

configure_from_settings()

# `langchain_community.embeddings.HuggingFaceEmbeddings` is deprecated and will
# be removed in LangChain 1.0. The replacement lives in the separate
# `langchain-huggingface` package, which is not installed here — so prefer it
# when present and fall back otherwise. Installing it is a one-line change:
#
#     pip install langchain-huggingface
#
# and this import starts using it with no other edit.
try:
    from langchain_huggingface import HuggingFaceEmbeddings  # type: ignore[import-not-found]

    _EMBEDDINGS_SOURCE = "langchain_huggingface"
except ImportError:
    with warnings.catch_warnings():
        # Suppress only this deprecation, and only around this import. A blanket
        # filter would hide the next deprecation that actually needs acting on.
        warnings.filterwarnings("ignore", category=DeprecationWarning)
        try:
            from langchain_core._api.deprecation import LangChainDeprecationWarning

            warnings.filterwarnings("ignore", category=LangChainDeprecationWarning)
        except ImportError:
            pass
        from langchain_community.embeddings import HuggingFaceEmbeddings

    _EMBEDDINGS_SOURCE = "langchain_community (deprecated)"

from config.settings import get_settings

logger = logging.getLogger(__name__)


@lru_cache(maxsize=1)
def get_embedding_model() -> HuggingFaceEmbeddings:
    """
    Load and cache the BGE embedding model. The first call downloads the model
    (~135 MB); later calls return the cached instance.

    Returns:
        HuggingFaceEmbeddings instance ready for .embed_documents() and .embed_query()
    """
    settings = get_settings()
    logger.info(
        "Loading embedding model: %s (via %s)",
        settings.EMBEDDING_MODEL_NAME,
        _EMBEDDINGS_SOURCE,
    )

    model = HuggingFaceEmbeddings(
        model_name=settings.EMBEDDING_MODEL_NAME,
        model_kwargs={"device": "cpu"},
        encode_kwargs={"normalize_embeddings": True},  # BGE models need normalization
    )

    logger.info("Embedding model loaded successfully")
    return model
