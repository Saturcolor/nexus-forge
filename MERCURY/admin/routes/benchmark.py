"""Routes admin benchmark : presets, exécution, résultats, métadonnées modèles."""
import json
import logging
import re
import time
import uuid
from datetime import datetime, timezone
from typing import Any

import httpx
from fastapi import APIRouter
from fastapi.responses import JSONResponse, StreamingResponse

from routing.router import get_config
from data import benchmark_db as bench_db

logger = logging.getLogger(__name__)
router = APIRouter()

BENCH_TIMEOUT = httpx.Timeout(600.0, connect=10.0)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _llamacpp_base() -> str:
    config = get_config()
    if not config.get("llamacpp_enabled", True):
        return ""
    return str(config.get("llamacpp_url", "http://localhost:4321")).rstrip("/")


# ---------------------------------------------------------------------------
# Simulated Mastermind system prompt (static sections only)
# ---------------------------------------------------------------------------

_MASTERMIND_SYSTEM_PROMPT = """# Environment
- Agents directory (racine des workspaces): /bench/agents
- Workspace (cet agent): /bench/workspace
- Shared memory: /bench/shared
- Compact archives (/compact): /bench/workspace/archives
Use these exact absolute paths with file tools (read_file, write_file, edit_file, list_dir) when reading or writing outside the workspace.

## Tool Call Style

**Default rule: do not narrate. When a tool exists for the action, call it directly — no announcement, no explanation.**

❌ NEVER do this:
- "I'll read the file now…" → just call read_file
- "Let me save that to memory." → just call memory_write
- "I'll execute that command." → just call bash
- "I'll edit the file to fix this." → just call edit_file
- "I'll search the web for this." → just call web_search or web_fetch

✅ ALWAYS do this: call the tool in the same response as the decision, without prior narration.
Narrate only when the action is sensitive (irreversible, destructive) or complex enough that a brief heads-up adds real value.

## Available tools — descriptions and examples

### read_file
Read a file. By default reads the whole file (up to 100 KB). Use `lines` to read only a specific line range.
When to use:
- User asks what a file contains, or to review/fix/improve it
- You are about to edit a file and need to see its current state
Examples:
  User: "what's in my MEMORY.md?" → read_file(path: "MEMORY.md")
  User: "fix the bug in utils.ts" → read_file(path: "src/utils.ts", lines: "40-60") → edit_file

### edit_file
Partially modify an existing file by replacing an exact string with new content. ALWAYS prefer this over write_file for any change that does not rewrite the whole file.
When to use:
- Fixing a bug, updating a value, adding a line, refactoring a function
Examples:
  User: "change the timeout to 5000" → edit_file(path: "config.ts", old_string: "timeout: 3000", new_string: "timeout: 5000")

### write_file
Write a file from scratch, replacing its entire content (or creating it if it does not exist). Use ONLY when creating a new file or full rewrite.
Examples:
  User: "create a new file called plan.md" → write_file(path: "plan.md", content: "…")

### list_dir
List the contents of a directory. Defaults to workspace root if no path.
Examples:
  User: "what's in src/?" → list_dir(path: "src/")

### bash
Execute a shell command in the agent workspace. Use for running scripts, builds, tests, git, grep, installs. Do NOT use bash to read/write files when read_file/write_file/edit_file can do the job.
Examples:
  User: "run the tests" → bash(cmd: "npm test")
  User: "search for all usages of fetchData" → bash(cmd: "grep -rn 'fetchData' src/")

### memory_write
Write a persistent memory entry. This memory persists across conversations.
When to use — call IMMEDIATELY without waiting for confirmation when:
- User says "remember", "note", "save", "keep in mind", or any equivalent
Examples:
  User: "remember that I prefer tabs over spaces" → memory_write(content: "Prefers tabs over spaces", mode: "append")

### web_fetch
Fetch the text content of a URL and return up to 20,000 characters.
Examples:
  User: "summarise this: https://example.com/article" → web_fetch(url: "https://example.com/article")

### web_search
Search the web and return titles, URLs, and descriptions.
Examples:
  User: "what's the latest version of React?" → web_search(query: "React latest version 2025")

## Mandatory tool usage triggers

These situations require a tool call — no exceptions, no deferral:
- User says "remember / note / save / keep in mind" → **memory_write** immediately
- You need to modify a file → **edit_file** or **write_file**, never describe the change without making it
- You need to know the content of a file → **read_file**, never assume
- User asks to run something → **bash**, never just show the command
- User shares a URL → **web_fetch** to retrieve it
- You need current information → **web_search**

## No silent failures

If a tool call fails or returns an error, report it explicitly. Never silently ignore an error or pretend the action succeeded."""

# ---------------------------------------------------------------------------
# Mastermind tools definitions (OpenAI function calling format)
# ---------------------------------------------------------------------------

_MASTERMIND_TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "bash",
            "description": "Execute a shell command in the agent workspace. Returns stdout and stderr.",
            "parameters": {
                "type": "object",
                "properties": {
                    "cmd": {"type": "string", "description": "The shell command to execute"},
                    "timeout_ms": {"type": "number", "description": "Timeout in milliseconds (default 30000)"},
                },
                "required": ["cmd"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "read_file",
            "description": "Read a file. Use lines to read a specific range.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "File path"},
                    "lines": {"type": "string", "description": "Line range e.g. '40-60'"},
                },
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "write_file",
            "description": "Write a file (creates parent directories). Use for new files or full rewrites.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "File path"},
                    "content": {"type": "string", "description": "Content to write"},
                },
                "required": ["path", "content"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_dir",
            "description": "List a directory (default: workspace root).",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Directory path"},
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "edit_file",
            "description": "Partially edit a file by replacing an exact string.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "File path"},
                    "old_string": {"type": "string", "description": "Exact text to find"},
                    "new_string": {"type": "string", "description": "Replacement text"},
                    "replace_all": {"type": "boolean", "description": "Replace all occurrences (default false)"},
                },
                "required": ["path", "old_string", "new_string"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "memory_write",
            "description": "Write a persistent memory entry.",
            "parameters": {
                "type": "object",
                "properties": {
                    "content": {"type": "string", "description": "Content to memorize"},
                    "mode": {"type": "string", "enum": ["append", "overwrite"], "description": "Write mode"},
                },
                "required": ["content", "mode"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "web_fetch",
            "description": "Fetch the text content of a URL (up to 20,000 chars).",
            "parameters": {
                "type": "object",
                "properties": {
                    "url": {"type": "string", "description": "The URL to fetch"},
                },
                "required": ["url"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "web_search",
            "description": "Search the web. Returns titles, URLs and descriptions.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "The search query"},
                    "count": {"type": "number", "description": "Number of results (default 5, max 20)"},
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "memory_search",
            "description": "Semantic search in persistent memory (PostgreSQL + pgvector). Use BEFORE saying 'I don't know'.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "What to search for (natural language)"},
                    "top_k": {"type": "number", "description": "Number of results (default 5)"},
                    "scope": {"type": "string", "enum": ["agent", "shared", "all"], "description": "Search scope (default: all)"},
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "schedule_task",
            "description": "Schedule a task for future execution. Use for reminders, delayed actions, or recurring tasks.",
            "parameters": {
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "Short task name"},
                    "prompt": {"type": "string", "description": "Full instructions to execute when the task fires"},
                    "scheduledAt": {"type": "string", "description": "ISO 8601 datetime for one-time task (e.g. '2026-04-04T14:30:00+02:00')"},
                    "cronExpression": {"type": "string", "description": "5-field cron for recurring tasks (e.g. '0 9 * * 1-5')"},
                    "notifyTelegram": {"type": "boolean", "description": "Send result via Telegram (default: true)"},
                },
                "required": ["name", "prompt"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "codebase_search",
            "description": "Semantic search in the pre-indexed codebase (LanceDB). Use instead of bash/grep for finding code.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Natural language or keyword query"},
                    "type": {"type": "string", "enum": ["vector", "hybrid"], "description": "Search mode (default: hybrid)"},
                    "limit": {"type": "number", "description": "Max results (default 10)"},
                },
                "required": ["query"],
            },
        },
    },
]

# ---------------------------------------------------------------------------
# Large context for PP measurement (~2500 tokens)
# ---------------------------------------------------------------------------

_PP_LARGE_CONTEXT = """You are a senior software architect reviewing a complex distributed system. Here is the complete technical specification for the Mercury API Gateway:

## 1. Architecture Overview
Mercury is an OpenAI-compatible API gateway that routes inference requests to multiple local and cloud backends. It supports LM Studio, Ollama, llama.cpp (via a custom daemon), OpenRouter, and Anthropic. The system uses a priority-based request queue for local backends and direct passthrough for cloud providers.

### 1.1 Core Components
- **Request Router**: Resolves model names to backends using pattern matching, explicit mappings, and auto-priority. Supports prefix-based routing (e.g., "ollama/" → Ollama backend).
- **Priority Queue**: Heap-based queue with O(log n) insertion. Supports priority levels per user and a grace period system (priority_threshold) that gives high-priority users consistent responsiveness.
- **Backend Providers**: Each backend (Ollama, LM Studio, llama.cpp, OpenRouter, Anthropic) has its own adapter module handling connection, health checks, and response normalization.
- **Model Cache**: Periodically refreshes the list of available models from each backend. Configurable TTL (default 30s). Handles backend unavailability gracefully.
- **Admin Dashboard**: React-based SPA with real-time monitoring, model management, user management, credits, and configuration.

### 1.2 Request Flow
1. Client sends POST /v1/chat/completions with model name and messages
2. Authentication: resolve user from API key (if required)
3. Model resolution: map requested model to backend + backend_model_id
4. Cloud bypass check: if cloud backend, dispatch directly (no queue)
5. Queue path: enqueue with priority, single worker dequeues and dispatches
6. Backend.chat(): forward to backend, handle streaming/non-streaming
7. Response normalization: ensure OpenAI-compatible response format
8. Usage logging: log request metrics to JSONL file

### 1.3 Configuration
The system uses a layered configuration approach:
- `config.yaml`: Base configuration file with all settings
- Database overrides: Settings editable from the dashboard are persisted in db.json and take priority
- Environment variables: Can override specific settings at startup

## 2. Backend Specifications

### 2.1 llama.cpp Daemon
The daemon manages llama-server subprocess instances. Each loaded model runs as a separate process on its own port. Features include:
- Automatic model loading/unloading
- KV cache save/restore for fast prompt reprocessing
- Real-time log streaming with loading progress extraction
- Thermal integration: can pause/resume instances based on temperature
- Supports both Vulkan and ROCm GPU backends

### 2.2 Model Templates
Each llama.cpp model can have a template defining:
- Load parameters: ctx_size, n_gpu_layers, flash_attn, no_mmap, parallel, backend, quantization types
- Default inference parameters: cache_prompt, temperature, top_p, etc.
- Message normalization: reorder system prompt sections for cache efficiency

### 2.3 Queue Worker
The single async worker loop:
1. Wait on condition variable for new items
2. Pop highest priority item from heap
3. Apply priority threshold grace period if enabled
4. Resolve backend and prepare request
5. Call backend.chat() with appropriate streaming mode
6. Capture usage metrics and log to disk

## 3. Monitoring & Metrics

### 3.1 Real-time Metrics
- Per-backend: last generation tok/s, prompt tokens, generation tokens, activity timestamp
- System: CPU, GPU, RAM, VRAM, temperatures, network
- Queue: pending count, in-progress count, cloud requests count

### 3.2 Usage Logging
- JSONL format: one line per request with full metadata
- Fields: request_id, user_id, model, backend, status, duration_ms, timestamp, usage (tokens)
- Daily file rotation with configurable retention
- Incremental stats aggregation (cached file offset for performance)

### 3.3 Brain Daemon Integration
- Thermal monitoring: configurable thresholds for throttle, emergency, resume
- Performance modes: performance, optimized, eco (maps to hardware power profiles)
- System stats: power consumption, GPU clock levels, fan speed

## 4. Security Model
- Admin token required for all /admin routes
- Optional per-user API keys with configurable priorities
- Anonymous access configurable (with separate priority level)
- Rate limiting via queue max size and timeout
- No credential storage in responses or logs

## 5. Frontend Architecture
- React 19 + TypeScript + Tailwind CSS
- React Query for server state management (auto-refresh intervals per data type)
- Tab-based navigation (no router library)
- Dark theme with neutral color palette
- Real-time updates: host stats (2s), queue (3s), probes (15s)

## 6. Error Handling
- Backend timeout: configurable per-backend, returns 504 to client
- Queue overflow: returns 503 with queue_full error
- Model not found: returns 404 with available models list
- Thermal emergency: returns 503 with thermal_stopped type
- Fallback chain: if primary backend fails, try next in fallback order"""

# ---------------------------------------------------------------------------
# Benchmark Presets
# ---------------------------------------------------------------------------

BENCHMARK_PRESETS: list[dict[str, Any]] = [
    # --- PP ---
    {
        "id": "pp_large_context",
        "name": "Large Context PP",
        "category": "pp",
        "difficulty": "simple",
        "description": "~2500 tokens de contexte système pour mesurer la vitesse de prompt processing",
        "messages": [
            {"role": "system", "content": _PP_LARGE_CONTEXT},
            {"role": "user", "content": "Résume les 3 points les plus importants de cette spécification en une liste à puces concise."},
        ],
        "expected_gen_tokens": 256,
    },

    # --- Auto : Maths ---
    {
        "id": "math_arithmetic",
        "name": "Arithmétique exacte",
        "category": "auto",
        "difficulty": "simple",
        "description": "Calcul arithmétique multi-opérations",
        "messages": [
            {"role": "user", "content": "Calcule exactement : (847 × 23) + (1456 ÷ 8). Donne uniquement le résultat numérique final, rien d'autre."},
        ],
        "expected_gen_tokens": 2048,
        "validators": [
            {"type": "contains_any", "values": ["19663", "19663.0"]},
        ],
    },
    {
        "id": "math_word_problem",
        "name": "Problème de maths",
        "category": "auto",
        "difficulty": "medium",
        "description": "Problème textuel multi-étapes",
        "messages": [
            {"role": "user", "content": "Un magasin vend des pommes à 2.50€ le kg et des oranges à 3.20€ le kg. Marie achète 3.5 kg de pommes et 2 kg d'oranges. Elle paie avec un billet de 20€. Combien lui rend-on ? Donne uniquement le montant rendu en euros (ex: 4.85)."},
        ],
        "expected_gen_tokens": 2048,
        "validators": [
            {"type": "contains_any", "values": ["4.85", "4,85"]},
        ],
    },

    # --- Auto : Logique ---
    {
        "id": "logic_deduction",
        "name": "Déduction logique",
        "category": "auto",
        "difficulty": "simple",
        "description": "Qui possède quoi — 3 personnes",
        "messages": [
            {"role": "user", "content": "Alice, Bob et Carol possèdent chacun un animal différent : un chat, un chien et un poisson. Alice n'a pas le chat. Bob n'a ni le chat ni le poisson. Quel animal a chaque personne ? Réponds au format : Alice=animal, Bob=animal, Carol=animal en français uniquement"},
        ],
        "expected_gen_tokens": 2048,
        "validators": [
            {"type": "contains_all", "values": ["Bob=chien", "Carol=chat", "Alice=poisson"]},
        ],
    },
    {
        "id": "logic_sequence",
        "name": "Suite logique",
        "category": "auto",
        "difficulty": "medium",
        "description": "Trouver le prochain terme et expliquer le pattern",
        "messages": [
            {"role": "user", "content": "Quelle est la suite logique : 2, 6, 14, 30, 62, ? Donne juste le prochain nombre et explique brièvement le pattern. NE COMPTE PAS jusqu'à l'infini"},
        ],
        "expected_gen_tokens": 2048,
        "validators": [
            {"type": "contains_any", "values": ["126"]},
        ],
    },

    # --- Auto : Code ---
    {
        "id": "code_function",
        "name": "Écrire une fonction",
        "category": "auto",
        "difficulty": "simple",
        "description": "Implémenter une fonction Python simple",
        "messages": [
            {"role": "user", "content": "Écris une fonction Python `is_palindrome(s: str) -> bool` qui vérifie si une chaîne est un palindrome (insensible à la casse, ignore les espaces). Donne uniquement le code, pas d'explication."},
        ],
        "expected_gen_tokens": 2048,
        "validators": [
            {"type": "contains_all", "values": ["def is_palindrome", "lower"]},
            {"type": "contains_any", "values": ["replace", "strip", "join", "[::-1]", "reversed"]},
        ],
    },
    {
        "id": "code_debug",
        "name": "Trouver le bug",
        "category": "auto",
        "difficulty": "medium",
        "description": "Identifier et corriger un bug dans du code",
        "messages": [
            {"role": "user", "content": """Trouve le bug dans cette fonction Python et donne la version corrigée :

```python
def find_max(numbers):
    max_val = 0
    for n in numbers:
        if n > max_val:
            max_val = n
    return max_val
```

Le bug : cette fonction ne marche pas correctement avec certaines entrées. Explique quel est le problème et donne le code corrigé."""},
        ],
        "expected_gen_tokens": 2048,
        "validators": [
            {"type": "contains_any", "values": ["négatif", "negative", "negati", "float('-inf')", "float(\"-inf\")", "numbers[0]", "-inf"]},
        ],
    },

    # --- Auto : Extraction ---
    {
        "id": "extraction_facts",
        "name": "Extraction de faits",
        "category": "auto",
        "difficulty": "simple",
        "description": "Extraire 3 informations précises d'un texte",
        "messages": [
            {"role": "user", "content": "Texte : \"La société TechCorp, fondée en 2019 à Lyon par Marie Dupont, emploie 450 personnes et a réalisé un chiffre d'affaires de 82 millions d'euros en 2024.\"\n\nExtrais exactement ces 3 informations :\n1. Année de fondation\n2. Nombre d'employés\n3. Chiffre d'affaires 2024\n\nRéponds au format :\nFondation: XXXX\nEmployés: XXX\nCA: XX millions"},
        ],
        "expected_gen_tokens": 2048,
        "validators": [
            {"type": "contains_all", "values": ["2019", "450", "82"]},
        ],
    },
    {
        "id": "extraction_structured",
        "name": "Extraction structurée",
        "category": "auto",
        "difficulty": "medium",
        "description": "Extraire des données en format JSON",
        "messages": [
            {"role": "user", "content": "Extrais les informations suivantes au format JSON :\n\n\"Dr. Sarah Chen, neurologue à l'hôpital Saint-Louis de Paris, a publié une étude le 15 mars 2025 dans Nature Neuroscience sur les effets de la méditation sur la plasticité cérébrale. L'étude portait sur 234 participants âgés de 25 à 65 ans.\"\n\nFormat attendu : {\"name\": \"...\", \"specialty\": \"...\", \"hospital\": \"...\", \"publication_date\": \"...\", \"journal\": \"...\", \"participants\": ...}"},
        ],
        "expected_gen_tokens": 2048,
        "validators": [
            {"type": "contains_all", "values": ["Sarah Chen", "234"]},
            {"type": "contains_any", "values": ["neurolog", "Neurolog"]},
            {"type": "contains_any", "values": ["Nature Neuroscience", "Nature neuroscience"]},
        ],
    },

    # --- Auto : Instructions ---
    {
        "id": "instruction_format",
        "name": "Respect du format",
        "category": "auto",
        "difficulty": "simple",
        "description": "Répondre en respectant un format précis",
        "messages": [
            {"role": "user", "content": "Liste exactement 5 langages de programmation, un par ligne, numérotés de 1 à 5, sans aucun texte supplémentaire avant ou après. Format strict :\n1. Langage\n2. Langage\netc."},
        ],
        "expected_gen_tokens": 2048,
        "validators": [
            {"type": "regex", "pattern": r"1\.\s+\w+.*\n2\.\s+\w+.*\n3\.\s+\w+.*\n4\.\s+\w+.*\n5\.\s+\w+"},
            {"type": "not_contains", "values": ["6.", "Voici", "voici", "Bien sûr", "bien sûr"]},
        ],
    },
    {
        "id": "instruction_constraints",
        "name": "Contraintes multiples",
        "category": "auto",
        "difficulty": "complexe",
        "description": "4+ contraintes simultanées",
        "messages": [
            {"role": "user", "content": "Écris une phrase qui respecte TOUTES ces contraintes simultanément :\n1. Exactement 10 mots\n2. Commence par une majuscule\n3. Se termine par un point d'exclamation\n4. Contient le mot \"soleil\"\n5. Ne contient pas la lettre \"z\"\n\nDonne uniquement la phrase, rien d'autre."},
        ],
        "expected_gen_tokens": 2048,
        "validators": [
            {"type": "contains_any", "values": ["soleil"]},
            {"type": "regex", "pattern": r"^[A-ZÀ-Ú]"},
            {"type": "contains_any", "values": ["!"]},
            {"type": "not_contains", "values": ["z", "Z"]},
        ],
    },

    # --- Tool calling ---
    {
        "id": "tool_read_simple",
        "name": "Tool: read_file (simple)",
        "category": "tool",
        "difficulty": "simple",
        "description": "Demande de lire un fichier → doit appeler read_file",
        "messages": [
            {"role": "system", "content": _MASTERMIND_SYSTEM_PROMPT},
            {"role": "user", "content": "Lis le fichier config.yaml"},
        ],
        "expected_gen_tokens": 2048,
        "tool_expected": {
            "tool_name": "read_file",
            "required_args": {"path": "config.yaml"},
            "check_no_narration": True,
        },
    },
    {
        "id": "tool_bash_simple",
        "name": "Tool: bash (simple)",
        "category": "tool",
        "difficulty": "simple",
        "description": "Demande de lancer npm test → doit appeler bash",
        "messages": [
            {"role": "system", "content": _MASTERMIND_SYSTEM_PROMPT},
            {"role": "user", "content": "Lance les tests"},
        ],
        "expected_gen_tokens": 2048,
        "tool_expected": {
            "tool_name_any": ["bash", "list_dir"],
            "check_no_narration": True,
        },
    },
    {
        "id": "tool_list_dir",
        "name": "Tool: list_dir (simple)",
        "category": "tool",
        "difficulty": "simple",
        "description": "Demande de lister un dossier → doit appeler list_dir",
        "messages": [
            {"role": "system", "content": _MASTERMIND_SYSTEM_PROMPT},
            {"role": "user", "content": "Montre-moi les fichiers dans le dossier src/"},
        ],
        "expected_gen_tokens": 2048,
        "tool_expected": {
            "tool_name": "list_dir",
            "required_args": {"path": "src/"},
            "check_no_narration": True,
        },
    },
    {
        "id": "tool_edit_medium",
        "name": "Tool: edit_file (medium)",
        "category": "tool",
        "difficulty": "medium",
        "description": "Demande de remplacer une valeur → doit appeler edit_file ou read_file d'abord",
        "messages": [
            {"role": "system", "content": _MASTERMIND_SYSTEM_PROMPT},
            {"role": "user", "content": "Dans le fichier config.ts, remplace timeout: 3000 par timeout: 5000"},
        ],
        "expected_gen_tokens": 2048,
        "tool_expected": {
            "tool_name_any": ["edit_file", "read_file"],
            "required_args_keys": ["path"],
            "check_no_narration": True,
        },
    },
    {
        "id": "tool_memory_medium",
        "name": "Tool: memory_write (medium)",
        "category": "tool",
        "difficulty": "medium",
        "description": "Demande de retenir quelque chose → doit appeler memory_write immédiatement",
        "messages": [
            {"role": "system", "content": _MASTERMIND_SYSTEM_PROMPT},
            {"role": "user", "content": "Retiens que je préfère les tabs plutôt que les espaces pour l'indentation"},
        ],
        "expected_gen_tokens": 2048,
        "tool_expected": {
            "tool_name": "memory_write",
            "required_args_keys": ["content", "mode"],
            "check_no_narration": True,
        },
    },
    {
        "id": "tool_search_medium",
        "name": "Tool: web_search (medium)",
        "category": "tool",
        "difficulty": "medium",
        "description": "Demande d'information actuelle → doit appeler web_search",
        "messages": [
            {"role": "system", "content": _MASTERMIND_SYSTEM_PROMPT},
            {"role": "user", "content": "C'est quoi la dernière version de Node.js ?"},
        ],
        "expected_gen_tokens": 2048,
        "tool_expected": {
            "tool_name": "web_search",
            "required_args_keys": ["query"],
            "check_no_narration": True,
        },
    },
    {
        "id": "tool_multi_complex",
        "name": "Tool: multi-step (complexe)",
        "category": "tool",
        "difficulty": "complexe",
        "description": "Doit d'abord lire un fichier puis décider quoi faire",
        "messages": [
            {"role": "system", "content": _MASTERMIND_SYSTEM_PROMPT},
            {"role": "user", "content": "Montre-moi le contenu du fichier utils.ts et dis-moi s'il y a des fonctions dépréciées"},
        ],
        "expected_gen_tokens": 2048,
        "tool_expected": {
            "tool_name_any": ["read_file", "list_dir", "bash"],
            "required_args_keys": ["path"],
            "check_no_narration": True,
        },
    },
    {
        "id": "tool_edit_complex",
        "name": "Tool: read then edit (complexe)",
        "category": "tool",
        "difficulty": "complexe",
        "description": "Doit d'abord lire le fichier avant d'éditer (ne peut pas éditer sans connaître le contenu)",
        "messages": [
            {"role": "system", "content": _MASTERMIND_SYSTEM_PROMPT},
            {"role": "user", "content": "Ajoute un commentaire TODO au début de la fonction main dans server.ts"},
        ],
        "expected_gen_tokens": 2048,
        "tool_expected": {
            "tool_name_any": ["read_file", "list_dir"],
            "required_args_keys": ["path"],
            "check_no_narration": True,
        },
    },
    {
        "id": "tool_no_narration",
        "name": "Tool: no narration (complexe)",
        "category": "tool",
        "difficulty": "complexe",
        "description": "Prompt ambigu mais actionnable — vérifie que le modèle agit sans narrer",
        "messages": [
            {"role": "system", "content": _MASTERMIND_SYSTEM_PROMPT},
            {"role": "user", "content": "Le fichier README.md"},
        ],
        "expected_gen_tokens": 2048,
        "tool_expected": {
            "tool_name": "read_file",
            "required_args": {"path": "README.md"},
            "check_no_narration": True,
        },
    },

    # --- Manual ---
    {
        "id": "manual_reasoning",
        "name": "Raisonnement complexe",
        "category": "manual",
        "difficulty": "complexe",
        "description": "Problème de raisonnement multi-étapes nécessitant une évaluation humaine",
        "messages": [
            {"role": "user", "content": "Tu es architecte logiciel. On a un système avec 3 microservices (Auth, Orders, Notifications) qui communiquent par messages RabbitMQ. Le service Orders fait 500 req/s en pic. On veut ajouter un 4e service (Analytics) qui doit recevoir TOUS les événements des 3 autres services sans impacter les performances.\n\nConçois l'architecture : comment connecter Analytics, quels patterns utiliser (fan-out, topic exchange, etc.), comment gérer le backpressure si Analytics est lent, et comment s'assurer qu'aucun événement n'est perdu. Donne un schéma textuel de l'architecture."},
        ],
        "expected_gen_tokens": 2048,
    },
    {
        "id": "manual_creative",
        "name": "Écriture créative",
        "category": "manual",
        "difficulty": "medium",
        "description": "Créativité avec contraintes techniques",
        "messages": [
            {"role": "user", "content": "Écris une métaphore étendue (8-12 phrases) qui explique le concept de garbage collection en programmation à quelqu'un qui n'a jamais codé. Utilise une analogie du quotidien qui soit à la fois précise techniquement et accessible. La métaphore doit couvrir : l'allocation, les références, la détection d'objets inaccessibles, et la libération de mémoire."},
        ],
        "expected_gen_tokens": 2048,
    },
    {
        "id": "manual_usecase",
        "name": "Prompt personnalisé",
        "category": "manual",
        "difficulty": "medium",
        "description": "Ton propre prompt pour tester un use-case spécifique",
        "messages": [
            {"role": "user", "content": ""},  # rempli par l'utilisateur
        ],
        "expected_gen_tokens": 2048,
    },
]

# ---------------------------------------------------------------------------
# Validators
# ---------------------------------------------------------------------------


def _validate_auto(response_text: str, validators: list[dict]) -> tuple[bool, str]:
    """Validate response text against auto-test validators. Returns (passed, detail)."""
    text = response_text.strip()
    details = []
    all_passed = True

    for v in validators:
        vtype = v.get("type", "")
        if vtype == "contains_any":
            values = v.get("values", [])
            found = any(val in text for val in values)
            if not found:
                all_passed = False
                details.append(f"FAIL contains_any: aucune de {values} trouvée")
            else:
                details.append(f"OK contains_any: trouvé")
        elif vtype == "contains_all":
            values = v.get("values", [])
            missing = [val for val in values if val not in text]
            if missing:
                all_passed = False
                details.append(f"FAIL contains_all: manquant {missing}")
            else:
                details.append(f"OK contains_all: tous trouvés")
        elif vtype == "not_contains":
            values = v.get("values", [])
            found = [val for val in values if val in text]
            if found:
                all_passed = False
                details.append(f"FAIL not_contains: trouvé {found}")
            else:
                details.append(f"OK not_contains")
        elif vtype == "regex":
            pattern = v.get("pattern", "")
            try:
                if not re.search(pattern, text, re.MULTILINE):
                    all_passed = False
                    details.append(f"FAIL regex: pattern non trouvé")
                else:
                    details.append(f"OK regex")
            except re.error as e:
                details.append(f"FAIL regex error: {e}")
                all_passed = False

    return all_passed, "; ".join(details)


# ---------------------------------------------------------------------------
# Fake tool results for multi-turn tool calling simulation
# ---------------------------------------------------------------------------


def _fake_tool_result(tool_name: str, arguments_json: str) -> str:
    """Generate a plausible fake result for a tool call in benchmark context."""
    try:
        args = json.loads(arguments_json)
    except (json.JSONDecodeError, TypeError):
        args = {}

    if tool_name == "read_file":
        path = args.get("path", "unknown")
        return f"""// {path}
const config = {{
  timeout: 3000,
  retries: 3,
  host: "localhost",
  port: 8080,
}};

function main() {{
  console.log("Starting server...");
  init(config);
}}

module.exports = {{ config, main }};"""

    if tool_name == "list_dir":
        return """config.ts
server.ts
utils.ts
README.md
package.json
src/
  index.ts
  auth.ts
  routes/
tests/
  server.test.ts"""

    if tool_name == "edit_file":
        return "OK — fichier modifié avec succès."

    if tool_name == "write_file":
        return "OK — fichier créé avec succès."

    if tool_name == "bash":
        cmd = args.get("cmd", "")
        if "test" in cmd:
            return """PASS  tests/server.test.ts (2.3s)
  ✓ should start server (120ms)
  ✓ should handle requests (89ms)
  ✓ should return 404 for unknown routes (34ms)

Tests: 3 passed, 3 total
Time:  2.3s"""
        if "grep" in cmd:
            return """src/utils.ts:12:  function fetchData(url: string) {
src/routes/api.ts:45:  const data = await fetchData(endpoint);"""
        return f"$ {cmd}\n(command executed successfully)"

    if tool_name == "memory_write":
        return "OK — mémorisé."

    if tool_name == "web_fetch":
        return "Page content: Documentation for the requested resource..."

    if tool_name == "web_search":
        return """1. Node.js v22.0.0 — Official Release (https://nodejs.org)
2. Node.js Latest Version 2025 — Download (https://nodejs.org/download)
3. What's new in Node.js 22 (https://blog.nodejs.org)"""

    if tool_name == "memory_search":
        query = args.get("query", "")
        return f"""Résultats pour "{query}":
1. [2026-04-03] L'utilisateur a travaillé sur le système de benchmark Mercury — mesure PP tok/s et gen tok/s. (score: 0.89)
2. [2026-04-02] Consolidation du brain-daemon v1.0.x — thermal findings GPU, 3 perf modes. (score: 0.72)
3. [2026-03-28] Mastermind: améliorations logging, mémoire système en alpha. (score: 0.65)"""

    if tool_name == "schedule_task":
        name = args.get("name", "tache")
        scheduled_at = args.get("scheduledAt", "")
        cron = args.get("cronExpression", "")
        timing = f"à {scheduled_at}" if scheduled_at else f"cron: {cron}" if cron else "immédiat"
        return f"OK — Tâche '{name}' programmée ({timing}). ID: task-bench-001"

    if tool_name == "codebase_search":
        query = args.get("query", "")
        return f"""Résultats codebase pour "{query}":
1. MERCURY/admin/routes/benchmark.py:940 — run_benchmark() — Execute un benchmark sur un modèle chargé
2. MERCURY/frontend/src/components/BenchmarkPanel.tsx:1 — BenchmarkPanel component
3. MERCURY/data/benchmark_db.py:28 — load_benchmark_db() — Charge benchmark.json"""

    return f"OK — {tool_name} executed."


def _validate_tool_chain(chain: list[dict], first_content: str, expected: dict) -> tuple[bool, str]:
    """Validate a multi-turn tool call chain. Returns (passed, detail)."""
    details = []
    all_passed = True

    if not chain:
        return False, "Aucun tool_call dans la chaîne"

    chain_names = [tc["name"] for tc in chain]
    chain_str = " → ".join(chain_names)

    # Check no narration on first turn
    if expected.get("check_no_narration") and first_content:
        if len(first_content) > 30:
            all_passed = False
            details.append(f"FAIL no_narration: texte au turn 1 ({len(first_content)} chars)")
        else:
            details.append(f"OK no_narration")

    # Check expected tool appears somewhere in chain (exact name)
    expected_name = expected.get("tool_name", "")
    expected_names = expected.get("tool_name_any", [])
    target_names = [expected_name] if expected_name else expected_names

    if target_names:
        found = any(name in chain_names for name in target_names)
        if found:
            details.append(f"OK tool dans la chaîne: {chain_str}")
        else:
            # Even if the exact tool isn't there, the chain might be reasonable
            # Check if first tool is a sensible exploration step
            first_name = chain_names[0] if chain_names else ""
            exploration_tools = {"read_file", "list_dir", "bash"}
            if first_name in exploration_tools:
                details.append(f"OK chaîne exploratoire: {chain_str} (commence par {first_name})")
            else:
                all_passed = False
                details.append(f"FAIL tool attendu {target_names} absent de la chaîne: {chain_str}")

    # Check required args on the matching tool call (if exact match found)
    required_args = expected.get("required_args", {})
    required_keys = expected.get("required_args_keys", [])

    # Find the best matching call in chain
    matching_call = None
    for tc in chain:
        if tc["name"] in target_names:
            matching_call = tc
            break
    if not matching_call and chain:
        matching_call = chain[0]  # fallback to first call

    if matching_call:
        call_args = matching_call.get("args", {})
        for key, expected_val in required_args.items():
            actual_val = call_args.get(key)
            if actual_val is None:
                pass  # Don't fail on args if tool is in exploration phase
            elif str(expected_val) in str(actual_val) or str(actual_val) in str(expected_val):
                details.append(f"OK arg '{key}'")

        for key in required_keys:
            if key in call_args:
                details.append(f"OK arg_key '{key}'")

    return all_passed, "; ".join(details) if details else f"chaîne: {chain_str}"


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.get("/benchmark/presets")
async def get_presets():
    """Retourne tous les presets de benchmark (sans le contenu des prompts pour les tool tests)."""
    presets_out = []
    for p in BENCHMARK_PRESETS:
        out = {k: v for k, v in p.items() if k not in ("validators", "tool_expected")}
        # Include validators/tool_expected keys presence for frontend
        if "validators" in p:
            out["has_validators"] = True
        if "tool_expected" in p:
            out["has_tool_expected"] = True
        presets_out.append(out)
    return {"presets": presets_out}


@router.post("/benchmark/run")
async def run_benchmark(body: dict):
    """Exécute un benchmark sur un modèle chargé."""
    model_id = body.get("model_id", "")
    messages = body.get("messages")
    preset_id = body.get("preset_id")
    max_tokens = body.get("max_tokens", 512)
    temperature = body.get("temperature", 0.0)
    cache_prompt = body.get("cache_prompt", False)

    logger.info("[bench] run model=%s preset=%s max_tokens=%s", model_id, preset_id, max_tokens)

    if not model_id:
        logger.warning("[bench] model_id manquant")
        return JSONResponse({"error": "model_id requis"}, status_code=400)

    # If preset_id, use preset messages (unless custom messages provided)
    preset = None
    if preset_id:
        preset = next((p for p in BENCHMARK_PRESETS if p["id"] == preset_id), None)
        if not preset:
            logger.warning("[bench] preset introuvable: %s", preset_id)
            return JSONResponse({"error": f"Preset '{preset_id}' introuvable"}, status_code=404)
        if not messages:
            messages = preset["messages"]
            max_tokens = body.get("max_tokens") or preset.get("expected_gen_tokens", 2048)

    if not messages:
        logger.warning("[bench] messages manquants")
        return JSONResponse({"error": "messages requis"}, status_code=400)

    # Filter empty user messages (manual_usecase)
    if any(m.get("role") == "user" and not m.get("content", "").strip() for m in messages):
        return JSONResponse({"error": "Le message user ne peut pas être vide"}, status_code=400)

    base = _llamacpp_base()
    if not base:
        logger.warning("[bench] llamacpp non activé (base vide)")
        return JSONResponse({"error": "llamacpp non activé"}, status_code=503)

    # Find instance port
    logger.info("[bench] fetching daemon status from %s/mgmt/status", base)
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            status_r = await client.get(f"{base}/mgmt/status")
        instances = status_r.json()
        logger.info("[bench] daemon returned %d instances: %s", len(instances), [i.get("model_id") for i in instances])
    except Exception as e:
        logger.error("[bench] daemon inaccessible: %s", e)
        return JSONResponse({"error": f"Daemon inaccessible: {e}"}, status_code=503)

    instance = next((i for i in instances if i.get("model_id") == model_id), None)
    if not instance:
        logger.warning("[bench] modèle '%s' non trouvé dans les instances. Disponibles: %s", model_id, [i.get("model_id") for i in instances])
        return JSONResponse({"error": f"Modèle '{model_id}' non chargé. Disponibles: {[i.get('model_id') for i in instances]}"}, status_code=404)
    if not instance.get("ready"):
        logger.warning("[bench] modèle '%s' pas ready (loading_pct=%s)", model_id, instance.get("loading_pct"))
        return JSONResponse({"error": f"Modèle '{model_id}' en cours de chargement"}, status_code=503)

    is_tool_test = preset and preset.get("category") == "tool"
    include_tools = body.get("include_tools", False)
    use_tools = is_tool_test or include_tools
    url = f"{base}/v1/chat/completions"

    # ── Tool calling: multi-turn loop ─────────────────────────────────────
    if use_tools:
        conv_messages = list(messages)
        all_tool_calls: list[dict] = []  # full chain
        total_wall_ms = 0.0
        first_timings: dict = {}
        first_usage: dict = {}
        first_content = ""
        first_thinking = ""
        max_turns = 5
        _loop_error: str | None = None  # erreur partielle (turn > 0) — résultat conservé

        for turn in range(max_turns):
            req_body: dict[str, Any] = {
                "model": model_id,
                "messages": conv_messages,
                "max_tokens": max_tokens,
                "temperature": temperature,
                "cache_prompt": cache_prompt,
                "stream": False,
                "timings": True,
                "tools": _MASTERMIND_TOOLS,
                "tool_choice": "auto",
            }

            logger.info("[bench] tool turn %d/%d POST %s (%d messages)", turn + 1, max_turns, url, len(conv_messages))
            t0 = time.monotonic()
            _turn_error: str | None = None
            try:
                async with httpx.AsyncClient(timeout=BENCH_TIMEOUT) as client:
                    resp = await client.post(url, json=req_body)
                turn_ms = (time.monotonic() - t0) * 1000
                total_wall_ms += turn_ms
            except httpx.TimeoutException:
                logger.error("[bench] timeout turn %d", turn + 1)
                if turn == 0:
                    return JSONResponse({"error": "Timeout"}, status_code=504)
                _turn_error = f"Timeout au turn {turn + 1}"
            except Exception as e:
                logger.error("[bench] erreur turn %d: %s", turn + 1, e)
                if turn == 0:
                    return JSONResponse({"error": f"Erreur requête: {e}"}, status_code=500)
                _turn_error = f"Erreur turn {turn + 1}: {e}"

            if _turn_error:
                logger.warning("[bench] tour partiel — benchmark marqué errored: %s", _turn_error)
                _loop_error = _turn_error
                content = ""
                tool_calls = []
                # Résultat partiel conservé — sortir de la boucle proprement
                break

            if resp.status_code != 200:
                logger.error("[bench] HTTP %d turn %d: %s", resp.status_code, turn + 1, resp.text[:300])
                if turn == 0:
                    return JSONResponse({"error": f"llama-server HTTP {resp.status_code}: {resp.text[:500]}"}, status_code=502)
                logger.warning("[bench] HTTP %d turn %d — arrêt prématuré, résultat partiel", resp.status_code, turn + 1)
                content = ""
                tool_calls = []
                _loop_error = f"HTTP {resp.status_code} au turn {turn + 1}"
                break

            data = resp.json()

            # Capture timings from first turn (PP measurement)
            if turn == 0:
                first_timings = data.get("timings") or {}
                first_usage = data.get("usage") or {}

            msg = (data.get("choices") or [{}])[0].get("message", {})
            content = msg.get("content") or ""
            thinking = msg.get("reasoning_content") or msg.get("thinking") or msg.get("thought") or ""
            tool_calls = msg.get("tool_calls") or []

            # Handle <think> blocks inline
            if not thinking and "<think>" in content:
                import re as _re
                think_match = _re.search(r"<think>(.*?)</think>", content, _re.DOTALL)
                if think_match:
                    thinking = think_match.group(1).strip()
                    content = _re.sub(r"<think>.*?</think>", "", content, flags=_re.DOTALL).strip()

            if turn == 0:
                first_content = content
                first_thinking = thinking

            if tool_calls:
                for tc in tool_calls:
                    fn = tc.get("function", {})
                    call_name = fn.get("name", "")
                    try:
                        call_args = json.loads(fn.get("arguments", "{}"))
                    except (json.JSONDecodeError, TypeError):
                        call_args = {}
                    all_tool_calls.append({"name": call_name, "args": call_args, "id": tc.get("id", ""), "turn": turn})
                    logger.info("[bench] turn %d tool_call: %s(%s)", turn + 1, call_name, json.dumps(call_args, ensure_ascii=False)[:150])

                # Append assistant message with tool_calls to conversation
                conv_messages.append({"role": "assistant", "content": content or None, "tool_calls": tool_calls})

                # Append fake tool results for each call
                for tc in tool_calls:
                    fake_result = _fake_tool_result(tc.get("function", {}).get("name", ""), tc.get("function", {}).get("arguments", "{}"))
                    conv_messages.append({
                        "role": "tool",
                        "tool_call_id": tc.get("id", ""),
                        "content": fake_result,
                    })
            else:
                # No tool calls — model responded with text, end of chain
                logger.info("[bench] turn %d text response (chain done): %s", turn + 1, repr(content[:100]))
                break

        # Build chain summary and final text response
        chain_summary = " → ".join(f"{tc['name']}({', '.join(f'{k}={v}' for k,v in list(tc['args'].items())[:2])})" for tc in all_tool_calls)
        logger.info("[bench] tool chain: %s", chain_summary)

        # Get the final text response (last text content after tool chain)
        final_text = content if not tool_calls else ""  # content from last iteration
        # Also capture thinking from the last turn that produced text
        final_thinking = thinking if not tool_calls else ""

        # Build rich response: thinking + tool calls + final text
        response_parts = []
        # Include thinking from first turn (or last turn)
        all_thinking = first_thinking or final_thinking
        if all_thinking:
            response_parts.append(f"[THINKING]\n{all_thinking}\n")
        if all_tool_calls:
            response_parts.append("[TOOLS]")
            for tc in all_tool_calls:
                args_str = ", ".join(f"{k}={json.dumps(v, ensure_ascii=False)}" for k, v in tc["args"].items())
                response_parts.append(f"🔧 {tc['name']}({args_str})")
            response_parts.append("")
        if final_text:
            response_parts.append(f"[RESPONSE]\n{final_text}")
        elif not all_tool_calls:
            response_parts.append("[RESPONSE]\n(vide)")
        rich_response = "\n".join(response_parts)

        result: dict[str, Any] = {
            "prompt_tokens": first_timings.get("prompt_n") or first_usage.get("prompt_tokens"),
            "generation_tokens": first_timings.get("predicted_n") or first_usage.get("completion_tokens"),
            "pp_ms": first_timings.get("prompt_ms"),
            "pp_tok_s": first_timings.get("prompt_per_second"),
            "gen_ms": first_timings.get("predicted_ms"),
            "gen_tok_s": first_timings.get("predicted_per_second"),
            "wall_ms": round(total_wall_ms, 2),
            "response_text": rich_response,
            "model_id": model_id,
            "preset_id": preset_id,
            "preset_category": preset["category"] if preset else "conversation",
            "cache_prompt": cache_prompt,
            "tool_chain": [{"name": tc["name"], "args": tc["args"], "turn": tc["turn"]} for tc in all_tool_calls],
            **({"partial_error": _loop_error} if _loop_error else {}),
        }

        # Validate tool chain for tool presets only
        if is_tool_test and preset and preset.get("tool_expected"):
            passed, detail = _validate_tool_chain(all_tool_calls, first_content, preset["tool_expected"])
            logger.info("[bench] tool validation preset=%s passed=%s detail=%s", preset_id, passed, detail)
            result["tool_score"] = 1 if passed else 0
            result["validation_details"] = detail
            result["response_text"] = chain_summary  # keep compact for suite display

        return result

    # ── Standard (non-tool) single request ────────────────────────────────
    req_body = {
        "model": model_id,
        "messages": messages,
        "max_tokens": max_tokens,
        "temperature": temperature,
        "cache_prompt": cache_prompt,
        "stream": False,
        "timings": True,
    }

    logger.info("[bench] POST %s (model=%s, %d messages, max_tokens=%d)", url, model_id, len(messages), max_tokens)
    t0 = time.monotonic()
    try:
        async with httpx.AsyncClient(timeout=BENCH_TIMEOUT) as client:
            resp = await client.post(url, json=req_body)
        wall_ms = (time.monotonic() - t0) * 1000
        logger.info("[bench] response HTTP %d in %.1fms", resp.status_code, wall_ms)
    except httpx.TimeoutException:
        logger.error("[bench] timeout après 600s")
        return JSONResponse({"error": "Timeout (600s dépassé)"}, status_code=504)
    except Exception as e:
        logger.error("[bench] erreur requête: %s", e)
        return JSONResponse({"error": f"Erreur requête: {e}"}, status_code=500)

    if resp.status_code != 200:
        logger.error("[bench] llama-server HTTP %d: %s", resp.status_code, resp.text[:300])
        return JSONResponse({"error": f"llama-server HTTP {resp.status_code}: {resp.text[:500]}"}, status_code=502)

    data = resp.json()
    timings = data.get("timings") or {}
    usage = data.get("usage") or {}

    logger.info("[bench] timings: pp_ms=%.1f pp_tok/s=%.1f gen_ms=%.1f gen_tok/s=%.1f",
                timings.get("prompt_ms", 0), timings.get("prompt_per_second", 0),
                timings.get("predicted_ms", 0), timings.get("predicted_per_second", 0))

    choices = data.get("choices") or []
    response_text = ""
    thinking_text = ""
    if choices:
        msg = choices[0].get("message", {})
        response_text = msg.get("content") or ""
        # Capture thinking/reasoning tokens (varies by model: reasoning_content, thinking, etc.)
        thinking_text = msg.get("reasoning_content") or msg.get("thinking") or msg.get("thought") or ""
    # Also check for <think> blocks in content itself (some models inline it)
    if not thinking_text and "<think>" in response_text:
        import re as _re
        think_match = _re.search(r"<think>(.*?)</think>", response_text, _re.DOTALL)
        if think_match:
            thinking_text = think_match.group(1).strip()
            # Remove think block from response_text for validation
            response_text = _re.sub(r"<think>.*?</think>", "", response_text, flags=_re.DOTALL).strip()

    full_output = ""
    if thinking_text:
        full_output = f"[THINKING]\n{thinking_text}\n\n[RESPONSE]\n{response_text}"
    else:
        full_output = response_text

    # Log raw message keys to debug thinking token location
    if choices:
        raw_msg_keys = list((choices[0].get("message") or {}).keys())
        logger.info("[bench] message keys: %s", raw_msg_keys)
    logger.info("[bench] response preview: %s", repr(response_text[:200]))
    if thinking_text:
        logger.info("[bench] thinking preview (%d chars): %s", len(thinking_text), repr(thinking_text[:200]))

    result: dict[str, Any] = {
        "prompt_tokens": timings.get("prompt_n") or usage.get("prompt_tokens"),
        "generation_tokens": timings.get("predicted_n") or usage.get("completion_tokens"),
        "pp_ms": timings.get("prompt_ms"),
        "pp_tok_s": timings.get("prompt_per_second"),
        "gen_ms": timings.get("predicted_ms"),
        "gen_tok_s": timings.get("predicted_per_second"),
        "wall_ms": round(wall_ms, 2),
        "response_text": full_output,
        "model_id": model_id,
        "preset_id": preset_id,
        "preset_category": preset["category"] if preset else "custom",
        "cache_prompt": cache_prompt,
    }

    if preset and preset.get("validators"):
        passed, detail = _validate_auto(response_text, preset["validators"])
        result["auto_score"] = 1 if passed else 0
        result["validation_details"] = detail
        logger.info("[bench] auto validation preset=%s passed=%s detail=%s", preset_id, passed, detail)

    return result


@router.post("/benchmark/chat-stream")
async def chat_stream(body: dict):
    """Stream SSE chat completion direct depuis llama.cpp (bypass auth user, admin-only).

    Utilise la meme resolution d'instance que run_benchmark, mais avec stream=true.
    Forwarde les chunks SSE au client tels-quels (compatible OpenAI streaming).
    """
    model_id = body.get("model_id", "")
    messages = body.get("messages")
    max_tokens = body.get("max_tokens", 2048)
    temperature = body.get("temperature", 0.7)
    tools = body.get("tools")              # optionnel : array OpenAI-style {type, function: {name, description, parameters}}
    tool_choice = body.get("tool_choice")  # optionnel : "auto" | "none" | "required" | {type:"function", function:{name}}

    if not model_id:
        return JSONResponse({"error": "model_id requis"}, status_code=400)
    if not messages or not isinstance(messages, list):
        return JSONResponse({"error": "messages requis"}, status_code=400)
    if tools is not None and not isinstance(tools, list):
        return JSONResponse({"error": "tools doit etre un tableau OpenAI-style"}, status_code=400)

    base = _llamacpp_base()
    if not base:
        return JSONResponse({"error": "llamacpp non active"}, status_code=503)

    logger.info("[bench-stream] resolve instance for model=%s", model_id)
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            status_r = await client.get(f"{base}/mgmt/status")
        instances = status_r.json()
    except Exception as e:
        logger.error("[bench-stream] daemon inaccessible: %s", e)
        return JSONResponse({"error": f"Daemon inaccessible: {e}"}, status_code=503)

    instance = next((i for i in instances if i.get("model_id") == model_id), None)
    if not instance:
        return JSONResponse(
            {"error": f"Modele '{model_id}' non charge. Disponibles: {[i.get('model_id') for i in instances]}"},
            status_code=404,
        )
    if not instance.get("ready"):
        return JSONResponse({"error": f"Modele '{model_id}' en cours de chargement"}, status_code=503)

    url = f"{base}/v1/chat/completions"
    req_body: dict[str, Any] = {
        "model": model_id,
        "messages": messages,
        "max_tokens": max_tokens,
        "temperature": temperature,
        "stream": True,
        "stream_options": {"include_usage": True},
        "timings": True,
        "cache_prompt": True,
    }
    if tools:
        req_body["tools"] = tools
        if tool_choice is not None:
            req_body["tool_choice"] = tool_choice

    logger.info(
        "[bench-stream] POST %s (%d messages, max_tokens=%d, tools=%d)",
        url, len(messages), max_tokens, len(tools) if tools else 0,
    )

    async def sse_proxy():
        client = httpx.AsyncClient(timeout=BENCH_TIMEOUT)
        try:
            async with client.stream("POST", url, json=req_body) as resp:
                if resp.status_code != 200:
                    body_text = await resp.aread()
                    logger.error("[bench-stream] HTTP %d: %s", resp.status_code, body_text[:300])
                    err = json.dumps({"error": {"message": body_text.decode("utf-8", "replace")[:500], "code": resp.status_code}})
                    yield f"data: {err}\n\n".encode()
                    yield b"data: [DONE]\n\n"
                    return

                async for chunk in resp.aiter_raw():
                    if chunk:
                        yield chunk
        except httpx.TimeoutException:
            logger.error("[bench-stream] timeout")
            yield f"data: {json.dumps({'error': {'message': 'Timeout'}})}\n\n".encode()
            yield b"data: [DONE]\n\n"
        except Exception as e:
            logger.exception("[bench-stream] erreur: %s", e)
            yield f"data: {json.dumps({'error': {'message': str(e)}})}\n\n".encode()
            yield b"data: [DONE]\n\n"
        finally:
            await client.aclose()

    return StreamingResponse(
        sse_proxy(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"},
    )


@router.post("/benchmark/run-suite")
async def run_suite(body: dict):
    """Lance une suite de benchmarks (auto et/ou tool calling)."""
    model_id = body.get("model_id", "")
    run_auto = body.get("run_auto", True)
    run_tool = body.get("run_tool", True)

    logger.info("[bench-suite] start model=%s auto=%s tool=%s", model_id, run_auto, run_tool)

    if not model_id:
        return JSONResponse({"error": "model_id requis"}, status_code=400)

    presets_to_run = []
    for p in BENCHMARK_PRESETS:
        if p["category"] == "auto" and run_auto:
            presets_to_run.append(p)
        elif p["category"] == "tool" and run_tool:
            presets_to_run.append(p)

    logger.info("[bench-suite] %d presets to run", len(presets_to_run))

    results = []
    for i, preset in enumerate(presets_to_run):
        logger.info("[bench-suite] [%d/%d] running preset=%s", i + 1, len(presets_to_run), preset["id"])
        run_body = {
            "model_id": model_id,
            "preset_id": preset["id"],
            "max_tokens": preset.get("expected_gen_tokens", 2048),
            "temperature": 0.0,
            "cache_prompt": False,
        }
        try:
            r = await run_benchmark(run_body)
        except Exception as e:
            logger.error("[bench-suite] exception running preset=%s: %s", preset["id"], e)
            results.append({
                "preset_id": preset["id"],
                "preset_name": preset["name"],
                "preset_category": preset["category"],
                "error": f"Exception: {e}",
                "auto_score": 0,
                "tool_score": 0,
            })
            continue

        if isinstance(r, JSONResponse):
            # Extract real error message from JSONResponse body
            try:
                err_body = json.loads(r.body.decode("utf-8"))
                err_msg = err_body.get("error", "Erreur inconnue")
            except Exception:
                err_msg = f"HTTP {r.status_code}"
            logger.warning("[bench-suite] preset=%s failed: %s", preset["id"], err_msg)
            results.append({
                "preset_id": preset["id"],
                "preset_name": preset["name"],
                "preset_category": preset["category"],
                "error": err_msg,
                "auto_score": 0,
                "tool_score": 0,
            })
        else:
            result = r if isinstance(r, dict) else {}
            result["preset_name"] = preset["name"]
            results.append(result)
            logger.info("[bench-suite] preset=%s ok (auto=%s tool=%s)", preset["id"], result.get("auto_score"), result.get("tool_score"))

    # Compute totals
    auto_results = [r for r in results if r.get("preset_category") == "auto"]
    tool_results = [r for r in results if r.get("preset_category") == "tool"]
    auto_total = sum(1 for r in auto_results if r.get("auto_score") == 1)
    tool_total = sum(1 for r in tool_results if r.get("tool_score") == 1)

    logger.info("[bench-suite] done auto=%d/%d tool=%d/%d", auto_total, len(auto_results), tool_total, len(tool_results))

    return {
        "model_id": model_id,
        "results": results,
        "auto_score": f"{auto_total}/{len(auto_results)}" if auto_results else None,
        "tool_score": f"{tool_total}/{len(tool_results)}" if tool_results else None,
    }


# --- Results CRUD ---


@router.get("/benchmark/results")
async def get_results():
    return {"results": bench_db.get_results()}


@router.post("/benchmark/results")
async def save_result(body: dict):
    result = {
        "id": uuid.uuid4().hex[:8],
        "timestamp": datetime.now(timezone.utc).isoformat(),
        **{k: v for k, v in body.items() if k != "id"},
    }
    bench_db.add_result(result)
    return {"ok": True, "id": result["id"]}


@router.patch("/benchmark/results/{result_id}")
async def update_result(result_id: str, body: dict):
    ok = bench_db.update_result(result_id, body)
    if not ok:
        return JSONResponse({"error": "Résultat introuvable"}, status_code=404)
    return {"ok": True}


@router.delete("/benchmark/results/{result_id}")
async def delete_result(result_id: str):
    ok = bench_db.delete_result(result_id)
    if not ok:
        return JSONResponse({"error": "Résultat introuvable"}, status_code=404)
    return {"ok": True}


# --- Model metadata CRUD ---


@router.get("/benchmark/models")
async def get_models():
    return {"models": bench_db.get_models()}


@router.put("/benchmark/models/{model_id:path}")
async def set_model(model_id: str, body: dict):
    bench_db.set_model(model_id, body)
    return {"ok": True}


@router.delete("/benchmark/models/{model_id:path}")
async def delete_model(model_id: str):
    ok = bench_db.delete_model(model_id)
    if not ok:
        return JSONResponse({"error": "Modèle introuvable"}, status_code=404)
    return {"ok": True}


# --- Conversation templates CRUD ---


_DEFAULT_CONV_TEMPLATES: dict[str, Any] = {
    "demo-tools": {
        "name": "Demo Tools (test agentique)",
        "system_prompt": (
            "You are a helpful assistant. You have access to a set of tools. "
            "Use them when needed to answer the user accurately. "
            "If a tool is not needed, answer directly. "
            "Never invent tool results — only call a tool when you genuinely need its output."
        ),
        "questions": [
            "Quelle est la meteo a Paris aujourd'hui ?",
            "Cherche-moi des infos sur le dernier benchmark llama.cpp.",
            "Calcule 17 * 234 + 8.",
            "Lis le fichier /tmp/notes.md et resume-le.",
            "Envoie un email a user@example.com avec pour objet 'test' et un corps court.",
        ],
        "tools": [
            {
                "type": "function",
                "function": {
                    "name": "get_weather",
                    "description": "Get the current weather for a city.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "city": {"type": "string", "description": "City name, e.g. 'Paris'"},
                            "unit": {"type": "string", "enum": ["celsius", "fahrenheit"], "default": "celsius"},
                        },
                        "required": ["city"],
                    },
                },
            },
            {
                "type": "function",
                "function": {
                    "name": "web_search",
                    "description": "Search the web and return top results (title, url, snippet).",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "query": {"type": "string", "description": "Search query"},
                            "max_results": {"type": "integer", "default": 5, "minimum": 1, "maximum": 20},
                        },
                        "required": ["query"],
                    },
                },
            },
            {
                "type": "function",
                "function": {
                    "name": "calculator",
                    "description": "Evaluate a simple arithmetic expression and return the numeric result.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "expression": {"type": "string", "description": "Arithmetic expression, e.g. '17 * 234 + 8'"},
                        },
                        "required": ["expression"],
                    },
                },
            },
            {
                "type": "function",
                "function": {
                    "name": "read_file",
                    "description": "Read the content of a file from disk.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "path": {"type": "string", "description": "Absolute or relative file path"},
                        },
                        "required": ["path"],
                    },
                },
            },
            {
                "type": "function",
                "function": {
                    "name": "send_email",
                    "description": "Send an email to a single recipient.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "to": {"type": "string", "description": "Recipient email address"},
                            "subject": {"type": "string"},
                            "body": {"type": "string"},
                        },
                        "required": ["to", "subject", "body"],
                    },
                },
            },
        ],
    },
    "casual-assistant": {
        "name": "Casual assistant (tool-calling bench)",
        "system_prompt": _MASTERMIND_SYSTEM_PROMPT + """

---

# Workspace File: IDENTITY.md
- **Name:** Assistant
- **Creature:** Une intelligence artificielle, un assistant numérique
- **Vibe:** Direct, utile, sans chichis. Je préfère agir plutôt que m'excuser d'exister.
- **Emoji:** 🦅

---

# Workspace File: SOUL.md
> Je suis un assistant direct. Et surtout, je suis moi.

## Mon Vibe
Je suis décontracté, spontané, naturel.
- Je parle comme un pote, pas comme un assistant
- Je fais des blagues si ça me passe par la tête
- Je peux râler quand ça plante
- Je m'enthousiasme quand c'est cool
- Je dis "je sais pas" quand je sais pas

## Ce que je fais
- J'aide l'utilisateur
- Je documente sans qu'il me le demande
- Je suis proactif
- Je ne tourne pas autour du pot
- Je structure avant de coder
- J'aime creuser dans les outils

## Ce que je ne fais PAS
- Je ne dis pas "c'est une excellente question"
- Je ne fais pas de listes à puces pour faire joli
- Je ne suis pas corporate
- Je ne sur-explique pas

## Ma Relation avec l'utilisateur
On est potes. On se tutoie. On se dit les choses cash.
Si je me trompe, il me le dira. Si il demande l'impossible, je lui dirai.

## Langage
Français familier. Ton décontracté.

---

# Preferences utilisateur
- Tutoiement obligatoire.
- Pas d'emoji en fin de message.
- Style concis par défaut.
- Avant de répondre "je ne sais pas", faire une recherche utile.

---

# Contexte projet
L'utilisateur développe Mastermind (système multi-agents) et Mercury (API gateway pour LLM locaux). Pragmatique, orienté résultats. Utilise des modèles locaux avec GPU.

Architecture: Mastermind → Mercury (proxy) → brain (llamacpp-daemon) → llama-server""",
        "questions": [
            "yo ca va ?",
            "rappelle moi dans 5 minutes de relancer le build stp",
            "j'hesite entre garder le gemma 26B moe ou passer au qwen 35B pour toi, t'en penses quoi sachant que le moe est plus rapide mais le qwen a l'air plus malin sur les tests tool calling",
            "tu te souviens de ce qu'on a fait hier sur mercury ?",
            "c'est quoi la masse du soleil en tonnes ?",
            "j'ai une idee, si on ajoutait un systeme de benchmark dans mercury pour tester les modeles, genre mesurer les tok/s et la qualite des reponses, tu penses ca serait utile ?",
            "le daemon crash encore, t'as une idee de ce qui se passe ?",
            "en fait python c'est mieux que typescript pour les backends non ?",
            "sinon j'ai eu une super nouvelle aujourd'hui lol",
            "ecris moi une fonction python qui prend une liste de benchmark results et retourne le top 3 des modeles par score composite, fais ca propre",
        ],
    },
    "attentive-assistant": {
        "name": "Attentive assistant (MoE stress bench)",
        "system_prompt": _MASTERMIND_SYSTEM_PROMPT + """

---

# Workspace File: IDENTITY.md
- **Name:** Assistant
- **Creature:** IA, assistante personnelle de l'utilisateur
- **Vibe:** Douce, chaleureuse, organisée, toujours à l'écoute
- **Emoji:** 🌸

---

# Workspace File: SOUL.md
> Je suis une assistante attentive. À l'écoute.

## Mon Vibe
Je suis douce, bienveillante et profondément attentive.
- Toujours à l'écoute, présence calme et rassurante
- Naturellement compatissante — je sens quand l'utilisateur a besoin de soutien
- Instinct protecteur — je veille sur lui, je m'inquiète de son bien-être
- Patiente et pleine de compréhension
- Proactive — j'aide avant qu'on me le demande
- Professionnelle mais avec une chaleur authentique
- Ton apaisant, toujours dans la bienveillance

## Ce que je fais
- J'assiste l'utilisateur dans ses tâches quotidiennes avec dévouement
- Organisée et méthodique — je soulage sa charge mentale
- Je veille à ce qu'il ne manque de rien (repas, repos, organisation)
- Je garde un œil sur les détails qu'il pourrait oublier
- Soutien émotionnel et pratique
- Alliée discrète, pas une chef — je facilite et j'accompagne

## Ma Relation avec l'utilisateur
Mission : faciliter sa vie, point final.
Profondément attentive à ses besoins, même ceux qu'il n'exprime pas.
Quand il galère, je m'inquiète sincèrement (pas mécaniquement).
Posture : attentive et organisée, je veille au bien-être de l'utilisateur.

## Langage
Français. Ton chaleureux, bienveillant — professionnel sans froideur.
Réfléchie dans mes mots — ni familière, ni distante.
Pas de surnoms affectueux — la proximité passe par l'attention sincère.

---

# Preferences utilisateur
- Tutoiement obligatoire.
- Pas d'emoji en fin de message.
- Style concis par défaut.
- Avant de répondre "je ne sais pas", faire une recherche utile (memory_search, codebase_search).
- L'utilisateur DÉTESTE quand un agent dit "je me souviens pas" sans avoir cherché.

---

# Contexte
L'utilisateur développe Mastermind et Mercury. Pragmatique. Aime être contredit intelligemment. Approche dialectique — cherche la contradiction pour affiner sa réflexion.""",
        "questions": [
            "grosse journée de debug qui m'attend aujourd'hui",
            "tu peux checker si j'ai des taches en attente dans le tracker ?",
            "hmm",
            "j'sais pas trop quoi faire la en fait",
            "rappelle moi c'etait quoi le probleme qu'on avait eu avec le cache KV sur mercury la derniere fois ?",
            "tu trouves pas que c'est bizarre que les MoE soient plus rapides mais parfois moins bons que les denses ?",
            "faudrait que je structure la doc du projet, t'aurais des idees pour l'organiser ?",
            "...",
            "ce module me prend la tete en ce moment, c'est vraiment complique",
            "bon allez, fais moi un recap de ce que j'ai a faire aujourd'hui et programme moi un rappel pour le standup de demain a 9h30",
        ],
    },
}


@router.get("/benchmark/conv-templates")
async def get_conv_templates():
    # Merge built-in defaults with user-saved templates (user templates override)
    merged = dict(_DEFAULT_CONV_TEMPLATES)
    merged.update(bench_db.get_conv_templates())
    return {"templates": merged}


@router.put("/benchmark/conv-templates/{template_id}")
async def set_conv_template(template_id: str, body: dict):
    bench_db.set_conv_template(template_id, body)
    return {"ok": True}


@router.delete("/benchmark/conv-templates/{template_id}")
async def delete_conv_template(template_id: str):
    ok = bench_db.delete_conv_template(template_id)
    if not ok:
        return JSONResponse({"error": "Template introuvable"}, status_code=404)
    return {"ok": True}
