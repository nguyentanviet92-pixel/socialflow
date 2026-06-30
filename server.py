"""
SocialFlow Hermes API v2.0 — Brain-mode (DB-backed + few-shot learning)

Changes from v1.1.0:
- Feedback + call stats persisted to PostgreSQL (survives restarts)
- Few-shot injection: past high-score outputs fed into each prompt
- Skill CRUD endpoints: edit prompts live via API, hot-reload
- Stats queries from DB, not in-memory deques

Runs as PM2 service on port 8100.
"""
import os
import sys
import io
import json
import logging
import time
import asyncio
from pathlib import Path
from contextlib import asynccontextmanager

# Force UTF-8 on stdout/stderr so Vietnamese chars in logs don't crash on
# VPS with ASCII locale (LANG=C / LANG=POSIX → sys.stdout.encoding='ascii').
os.environ.setdefault('PYTHONIOENCODING', 'utf-8')
for _s in (sys.stdout, sys.stderr):
    if isinstance(_s, io.TextIOWrapper):
        try:
            _s.reconfigure(encoding='utf-8', errors='replace')
        except Exception:
            pass

# Add Hermes to path (legacy — kept for import compat)
HERMES_HOME = Path.home() / '.hermes'
HERMES_AGENT = HERMES_HOME / 'hermes-agent'
sys.path.insert(0, str(HERMES_AGENT))

# Load env
from dotenv import load_dotenv
load_dotenv(HERMES_HOME / '.env')
load_dotenv(HERMES_AGENT / '.env')

from fastapi import FastAPI, HTTPException, Header, Body, BackgroundTasks
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from typing import Optional, List, Dict, Any
import uvicorn
import asyncpg
import httpx
from bs4 import BeautifulSoup

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger('hermes-api')

AGENT_SECRET = os.getenv('AGENT_SECRET', '')
# Defaults (overridden by hermes_config DB table at runtime)
DEEPSEEK_KEY = os.getenv('OPENAI_API_KEY', '')
DEEPSEEK_URL = os.getenv('OPENAI_BASE_URL', 'https://api.deepseek.com/v1')
MODEL = os.getenv('HERMES_MODEL', 'deepseek-chat')
DATABASE_URL = os.getenv('DATABASE_URL', 'postgresql://socialflow:sf_secure_2026_rot_4821a@127.0.0.1:5432/socialflow')

# Provider config — maps provider name to base URL and model list
# Models are SUGGESTIONS — user can type any custom model ID at frontend.
PROVIDERS = {
    'deepseek': {
        'base_url': 'https://api.deepseek.com/v1',
        'models': [
            'deepseek-v4-pro',     # V4 Pro — 1.6T params, top quality
            'deepseek-v4-flash',   # V4 Flash — 284B, fast+cheap, dual-mode (thinking/non-thinking)
            'deepseek-chat',       # V3 (legacy, retires 2026-07-24)
            'deepseek-reasoner',   # R1 (legacy, retires 2026-07-24)
        ],
        'label': 'DeepSeek',
    },
    'openrouter': {
        'base_url': 'https://openrouter.ai/api/v1',
        'models': [
            # Nous Research Hermes (tool-use tuned)
            'nousresearch/hermes-3-llama-3.1-405b',
            'nousresearch/hermes-3-llama-3.1-70b',
            'nousresearch/hermes-3-llama-3.1-8b',
            # Claude 4.x
            'anthropic/claude-opus-4',
            'anthropic/claude-sonnet-4-5',
            'anthropic/claude-haiku-4-5',
            # Claude 3.7 / 3.5
            'anthropic/claude-3.7-sonnet',
            'anthropic/claude-3.5-sonnet',
            'anthropic/claude-3.5-haiku',
            # OpenAI
            'openai/gpt-4.1',
            'openai/gpt-4.1-mini',
            'openai/gpt-4o',
            'openai/gpt-4o-mini',
            'openai/o3-mini',
            # Gemini
            'google/gemini-2.5-pro-preview',
            'google/gemini-2.0-flash-001',
            'google/gemini-2.0-flash-lite-001',
            'google/gemini-flash-1.5',
            # Meta Llama 4
            'meta-llama/llama-4-maverick',
            'meta-llama/llama-4-scout',
            'meta-llama/llama-3.3-70b-instruct',
            # Qwen 3
            'qwen/qwen3-235b-a22b',
            'qwen/qwen3-32b',
            'qwen/qwen-2.5-72b-instruct',
            # Mistral
            'mistralai/mistral-large-2411',
            'mistralai/mistral-small-3.1-24b-instruct',
            # xAI Grok
            'x-ai/grok-3-beta',
            'x-ai/grok-3-mini-beta',
            # DeepSeek via OpenRouter (fallback when direct is down)
            'deepseek/deepseek-chat',
            'deepseek/deepseek-r1',
        ],
        'label': 'OpenRouter (300+ models)',
        'allow_custom_model': True,
    },
    'nous': {
        'base_url': 'https://inference-api.nousresearch.com/v1',
        'models': [
            'Hermes-3-Llama-3.1-70B',
            'Hermes-3-Llama-3.1-405B',
            'DeepHermes-3-Llama-3-8B-Preview',
        ],
        'label': 'Nous Research (native)',
    },
    'openai': {
        'base_url': 'https://api.openai.com/v1',
        'models': [
            'gpt-4.1',
            'gpt-4.1-mini',
            'gpt-4.1-nano',
            'gpt-4o',
            'gpt-4o-mini',
            'o4-mini',
            'o3-mini',
        ],
        'label': 'OpenAI',
    },
    'groq': {
        'base_url': 'https://api.groq.com/openai/v1',
        'models': [
            'llama-3.3-70b-versatile',
            'llama-3.1-8b-instant',
            'llama3-groq-70b-8192-tool-use-preview',
            'gemma2-9b-it',
            'compound-beta',
            'compound-beta-mini',
        ],
        'label': 'Groq (fast + free tier)',
    },
    'anthropic': {
        'base_url': 'https://api.anthropic.com/v1',
        'models': [
            # Claude 4.x (latest)
            'claude-opus-4-7',
            'claude-sonnet-4-6',
            'claude-haiku-4-5-20251001',
            # Claude 3.7 / 3.5
            'claude-3-7-sonnet-20250219',
            'claude-3-5-sonnet-20241022',
            'claude-3-5-haiku-20241022',
        ],
        'label': 'Anthropic',
    },
    'gemini': {
        'base_url': 'https://generativelanguage.googleapis.com/v1beta/openai',
        'models': [
            'gemini-2.5-pro-preview-05-06',
            'gemini-2.0-flash',
            'gemini-2.0-flash-lite',
            'gemini-2.0-flash-thinking-exp',
            'gemini-1.5-flash',
            'gemini-1.5-pro',
        ],
        'label': 'Google Gemini',
    },
    'xai': {
        'base_url': 'https://api.x.ai/v1',
        'models': [
            'grok-3-beta',
            'grok-3-mini-beta',
            'grok-2-latest',
        ],
        'label': 'xAI Grok',
    },
    'nvidia': {
        'base_url': 'https://integrate.api.nvidia.com/v1',
        'models': [
            # MiniMax
            'minimaxai/minimax-m2.7',
            # Z.AI GLM (latest, reasoning-friendly)
            'z-ai/glm4.7',
            'z-ai/glm-4.5',
            # DeepSeek family (NVIDIA-hosted, no per-account quota)
            'deepseek-ai/deepseek-r1',
            'deepseek-ai/deepseek-v3-0324',
            # Meta Llama
            'meta/llama-3.3-70b-instruct',
            'meta/llama-3.1-405b-instruct',
            'meta/llama-3.1-70b-instruct',
            # Nvidia in-house (Nemotron tuned)
            'nvidia/llama-3.3-nemotron-super-49b-v1',
            'nvidia/llama-3.1-nemotron-70b-instruct',
            # Qwen 3
            'qwen/qwen3-235b-a22b',
            'qwen/qwq-32b',
            # Mistral
            'mistralai/mistral-large-2-instruct',
        ],
        'label': 'NVIDIA NIM (free tier)',
        'allow_custom_model': True,
    },
    'kimi': {
        'base_url': 'https://api.moonshot.ai/v1',  # international (.cn requires Chinese phone)
        'models': [
            'kimi-k2.6',                # latest (Apr 2026), multimodal, 256K ctx
            'kimi-k2.5',
            'kimi-k2-thinking-turbo',   # reasoning + faster
            'kimi-k2-thinking',
            'kimi-k2-0905-preview',
            'kimi-k2-turbo-preview',
        ],
        'label': 'Kimi (Moonshot)',
    },
}

# ── Per-skill model tier routing ─────────────────────────────
# Hermes routes each task_type to an appropriate model tier:
#   fast     → binary decisions, scoring (cheap, low-latency)
#   balanced → content generation, evaluation (quality vs cost)
#   smart    → complex orchestration, reasoning (best available)
#
# Runtime override: cfg['skill_models'][task_type] = 'model-id' (per-skill)
#                   cfg['tier_models'][tier]        = 'model-id' (per-tier)
SKILL_TIERS: Dict[str, str] = {
    # Fast: simple classification / yes-no
    'quality_gate':          'fast',
    'relevance_score':       'fast',
    'lead_score':            'fast',
    'action_decision':       'fast',
    'group_evaluator':       'fast',
    # Balanced: generation, nuanced evaluation
    'comment_gen':           'balanced',
    'caption_gen':           'balanced',
    'reply_gen':             'balanced',
    'post_eval':             'balanced',
    'content_eval':          'balanced',
    'reporter':              'balanced',
    # 2026-04-26: orchestrator moved smart→balanced. R1 reasoning burns the
    # entire token budget on chain-of-thought when context is large (10 nicks
    # + signals = ~8KB input), leaving nothing for the JSON answer. Skill is
    # rule-based enough for deepseek-chat to handle reliably.
    'orchestrator':          'balanced',
    'self_reviewer':         'smart',
    'cookie_death_analyzer': 'smart',
    # Anti-detection pre-orchestration: balanced is enough — they emit
    # structured JSON from clear rules, no creative reasoning needed.
    'checkpoint_predictor':  'balanced',
    'traffic_conductor':     'balanced',
    'social_graph_spreader': 'balanced',
    'kpi_coordinator':       'balanced',
    'generic':               'balanced',
}

# Default model per tier — can be overridden in hermes_config.tier_models
TIER_DEFAULTS: Dict[str, str] = {
    'fast':     'deepseek-chat',
    'balanced': 'deepseek-chat',
    'smart':    'deepseek-reasoner',
}

# Runtime config cache (DB is source of truth, refreshed on PUT)
_config_cache: Dict[str, Any] = {}
_config_cache_ts: float = 0
_CONFIG_CACHE_TTL = 30  # seconds

# ── DB pool (global) ──────────────────────────────────────
_db_pool: Optional[asyncpg.Pool] = None

async def _init_conn(conn):
    """Register JSONB codec on new connections so rows return dict/list not str."""
    await conn.set_type_codec(
        'jsonb', encoder=json.dumps, decoder=json.loads, schema='pg_catalog'
    )
    await conn.set_type_codec(
        'json', encoder=json.dumps, decoder=json.loads, schema='pg_catalog'
    )

async def get_pool() -> asyncpg.Pool:
    global _db_pool
    if _db_pool is None:
        _db_pool = await asyncpg.create_pool(
            DATABASE_URL, min_size=2, max_size=10, command_timeout=5,
            init=_init_conn,
        )
    return _db_pool

@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info('Starting Hermes API v2.0 — initializing DB pool')
    pool = await get_pool()
    try:
        await pool.execute("""
            CREATE TABLE IF NOT EXISTS wp_audit_results (
                site_idx INTEGER NOT NULL,
                post_id INTEGER NOT NULL,
                audit_data JSONB NOT NULL,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (site_idx, post_id)
            );

            CREATE TABLE IF NOT EXISTS page_analytics_cache (
                url TEXT PRIMARY KEY,
                post_id INTEGER,
                page_title TEXT,
                gsc_clicks INTEGER DEFAULT 0,
                gsc_impressions INTEGER DEFAULT 0,
                gsc_ctr FLOAT DEFAULT 0,
                gsc_position FLOAT DEFAULT 0,
                gsc_top_queries JSONB,
                ga4_sessions INTEGER DEFAULT 0,
                ga4_avg_time_sec INTEGER DEFAULT 0,
                ga4_bounce_rate FLOAT DEFAULT 0,
                ga4_pageviews INTEGER DEFAULT 0,
                fetched_at TIMESTAMP DEFAULT NOW(),
                date_range_days INTEGER DEFAULT 28
            );

            CREATE TABLE IF NOT EXISTS audit_score_history (
                id SERIAL PRIMARY KEY,
                url TEXT NOT NULL,
                post_id INTEGER,
                audit_score INTEGER,
                score_seo INTEGER,
                score_geo INTEGER,
                score_pillar INTEGER,
                score_semantic INTEGER,
                audit_data JSONB,
                audited_at TIMESTAMP DEFAULT NOW()
            );

            CREATE INDEX IF NOT EXISTS idx_audit_history_url ON audit_score_history(url);
            CREATE INDEX IF NOT EXISTS idx_audit_history_date ON audit_score_history(audited_at DESC);
        """)
        logger.info('wp_audit_results, page_analytics_cache, and audit_score_history tables verified')
    except Exception as e:
        logger.error('Failed to create DB tables: %s', e)
    yield
    if _db_pool:
        await _db_pool.close()


app = FastAPI(title='SocialFlow Hermes API', version='2.0.0', lifespan=lifespan)

# ── Auth ──────────────────────────────────────────────────
def verify_key(x_agent_key: str = Header(None)):
    if not AGENT_SECRET:
        raise HTTPException(500, 'AGENT_SECRET not configured')
    if x_agent_key != AGENT_SECRET:
        raise HTTPException(401, 'Invalid agent key')

# ── Skill loader (mutable, hot-reloadable) ────────────────
SKILLS_DIRS = [
    HERMES_HOME / 'skills' / 'socialflow',
    Path(__file__).parent / 'skills',
]
# Primary dir for writes (prefer project-local so edits survive Hermes reinstall)
PRIMARY_SKILL_DIR = Path(__file__).parent / 'skills'
PRIMARY_SKILL_DIR.mkdir(parents=True, exist_ok=True)

# Map task_type → skill filename aliases
# (first match in either SKILLS_DIRS wins)
TASK_ALIASES = {
    # Content generation
    'comment_gen':           ['comment-generator', 'comment'],
    'caption_gen':           ['caption', 'comment-generator', 'comment'],
    'reply_gen':             ['reply-gen', 'reply'],
    # Evaluation
    'post_eval':             ['post-evaluator', 'evaluator'],
    'content_eval':          ['post-evaluator', 'evaluator'],
    'quality_gate':          ['quality-gate', 'quality'],
    'relevance_score':       ['relevance-score', 'relevance'],
    'lead_score':            ['lead-score', 'lead'],
    # Decision
    'action_decision':       ['action-decision', 'action'],
    'group_evaluator':       ['group-evaluator', 'group-eval'],
    # Orchestrator family
    'orchestrator':          ['orchestrator'],
    'reporter':              ['reporter'],
    'self_reviewer':         ['self-reviewer', 'self-review'],
    'cookie_death_analyzer': ['cookie-death-analyzer', 'cookie-death'],
    # Anti-detection pre-orchestration pipeline (10 nicks / 1 machine)
    'checkpoint_predictor':  ['checkpoint-predictor'],
    'traffic_conductor':     ['traffic-conductor'],
    'social_graph_spreader': ['social-graph-spreader'],
    # KPI orchestration: action-allocation reasoning across nicks of varying quality
    'kpi_coordinator':       ['kpi-coordinator'],
}

SKILLS: Dict[str, str] = {}           # task_type → prompt text
SKILL_FILES: Dict[str, Path] = {}     # task_type → actual file path

def _parse_frontmatter(content: str) -> str:
    """Strip YAML frontmatter from skill md file."""
    if content.startswith('---'):
        parts = content.split('---', 2)
        if len(parts) >= 3:
            return parts[2].strip()
    return content.strip()

def resolve_skill_file(task_type: str) -> Optional[Path]:
    """Find the .md file for a task_type across skill dirs."""
    aliases = TASK_ALIASES.get(task_type, [task_type, task_type.replace('_', '-')])
    for skills_dir in SKILLS_DIRS:
        if not skills_dir.exists():
            continue
        for alias in aliases:
            for f in skills_dir.glob('*.md'):
                if alias in f.stem.lower():
                    return f
    return None

def load_all_skills():
    """(Re)load all skills from disk into SKILLS dict."""
    SKILLS.clear()
    SKILL_FILES.clear()
    for task_type in TASK_ALIASES.keys():
        f = resolve_skill_file(task_type)
        if f:
            try:
                SKILLS[task_type] = _parse_frontmatter(f.read_text(encoding='utf-8'))
                SKILL_FILES[task_type] = f
            except Exception as e:
                logger.error('Failed to load skill %s: %s', task_type, e)
                SKILLS[task_type] = ''
        else:
            SKILLS[task_type] = ''
    logger.info('Skills loaded: %s', {k: len(v) for k, v in SKILLS.items() if v})

load_all_skills()

DEFAULT_SKILL = "You are a helpful social media automation assistant. Be concise, natural, non-spammy."

# Map task_type → (max_tokens, temperature)
TASK_CONFIG = {
    # Content generation
    'comment_gen':           (150, 0.85),
    'caption_gen':           (600, 0.75),
    'reply_gen':             (150, 0.80),
    # Fast classification — low temp, short output
    'quality_gate':          (200, 0.10),
    'relevance_score':       (150, 0.10),
    'lead_score':            (200, 0.15),
    'action_decision':       (250, 0.25),
    'group_evaluator':       (300, 0.15),
    # Evaluation
    'post_eval':             (1500, 0.10),
    'content_eval':          (1500, 0.10),
    # Orchestrator family — larger context, lower temp
    'orchestrator':          (2000, 0.20),
    'reporter':              (1500, 0.30),
    'self_reviewer':         (2500, 0.20),
    'cookie_death_analyzer': (1500, 0.20),
    # Anti-detection pipeline — deterministic JSON, very low temp
    'checkpoint_predictor':  (1200, 0.10),
    'traffic_conductor':     (1500, 0.15),
    'social_graph_spreader': (1200, 0.10),
    'kpi_coordinator':       (2000, 0.30),
    'generic':               (600, 0.70),
}

# ── Few-shot example fetcher ──────────────────────────────
# How many examples to inject, and min score threshold.
FEWSHOT_COUNT = 3
FEWSHOT_MIN_SCORE = 4
MEMORY_LIMIT = 10          # max pilot memories to inject
MEMORY_MIN_CONFIDENCE = 0.3 # skip low-confidence memories

async def fetch_fewshot_examples(task_type: str, account_id: Optional[str] = None) -> List[Dict[str, Any]]:
    """
    Fetch top recent high-score examples for this task_type.
    Prefer same-account examples when available, fill rest with global examples.
    Returns list of {output_text, score, reason} dicts.
    """
    pool = await get_pool()
    examples = []

    try:
        if account_id:
            # Prefer same-account recent successes
            rows = await pool.fetch(
                """
                SELECT output_text, score, reason, created_at
                FROM hermes_feedback
                WHERE task_type = $1 AND account_id = $2 AND score >= $3
                ORDER BY created_at DESC
                LIMIT $4
                """,
                task_type, account_id, FEWSHOT_MIN_SCORE, FEWSHOT_COUNT,
            )
            examples.extend([dict(r) for r in rows])

        # Fill the rest with global (cross-account) examples
        remaining = FEWSHOT_COUNT - len(examples)
        if remaining > 0:
            existing_outputs = {e['output_text'] for e in examples}
            rows = await pool.fetch(
                """
                SELECT output_text, score, reason, created_at
                FROM hermes_feedback
                WHERE task_type = $1 AND score >= $2
                ORDER BY created_at DESC
                LIMIT $3
                """,
                task_type, FEWSHOT_MIN_SCORE, remaining * 3,  # fetch extra for dedup
            )
            for r in rows:
                if len(examples) >= FEWSHOT_COUNT:
                    break
                if r['output_text'] not in existing_outputs:
                    examples.append(dict(r))
                    existing_outputs.add(r['output_text'])

    except Exception as e:
        logger.warning('fetch_fewshot failed: %s', e)
        return []

    return examples

async def fetch_campaign_context(campaign_id: Optional[str]) -> Dict[str, Any]:
    """Fetch goal + hermes_context for a campaign — injected into prompts.
    Returns {} if campaign not found or fields empty."""
    if not campaign_id:
        return {}
    import re
    if not re.match(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', campaign_id, re.I):
        return {}
    try:
        pool = await get_pool()
        row = await pool.fetchrow(
            'SELECT name, goal, hermes_context FROM campaigns WHERE id = $1::uuid',
            campaign_id,
        )
        if not row:
            return {}
        return {
            'name': row['name'] or '',
            'goal': row['goal'] or '',
            'hermes_context': row['hermes_context'] or {},
        }
    except Exception as e:
        logger.warning('fetch_campaign_context failed: %s', e)
        return {}

def format_campaign_context_block(ctx: Dict[str, Any]) -> str:
    """Format campaign context for system prompt injection."""
    if not ctx or (not ctx.get('goal') and not ctx.get('hermes_context')):
        return ''

    lines = ['\n## Bối cảnh chiến dịch (campaign context)']
    if ctx.get('name'):
        lines.append(f"Tên: {ctx['name']}")
    if ctx.get('goal'):
        lines.append(f"\nMục tiêu:\n{ctx['goal'][:1500]}")

    hc = ctx.get('hermes_context') or {}
    if isinstance(hc, dict) and hc:
        lines.append('\n### Thông tin sản phẩm/thương hiệu')
        if hc.get('product_name'):
            lines.append(f"Sản phẩm: **{hc['product_name']}**")
        if hc.get('price'):
            lines.append(f"Giá: {hc['price']}")
        if hc.get('key_features'):
            feats = hc['key_features']
            if isinstance(feats, list):
                lines.append(f"Điểm mạnh: {', '.join(map(str, feats[:8]))}")
        if hc.get('target_audience'):
            lines.append(f"Đối tượng: {hc['target_audience']}")
        if hc.get('tone'):
            lines.append(f"Tone: {hc['tone']}")
        if hc.get('avoid'):
            avoid = hc['avoid']
            if isinstance(avoid, list):
                lines.append(f"⚠ TRÁNH: {', '.join(map(str, avoid[:8]))}")
        if hc.get('cta'):
            lines.append(f"CTA gợi ý: {hc['cta']}")
        if hc.get('brand_voice_examples'):
            exs = hc['brand_voice_examples']
            if isinstance(exs, list) and exs:
                lines.append('\nVí dụ giọng điệu thương hiệu:')
                for i, ex in enumerate(exs[:3], 1):
                    lines.append(f'  {i}. "{str(ex)[:200]}"')

    lines.append('\nKhi tạo nội dung, ưu tiên thông tin sản phẩm trên — nhưng phải tự nhiên, không hard-sell.')
    return '\n'.join(lines)

async def fetch_pilot_memories(account_id: Optional[str], campaign_id: Optional[str],
                                group_fb_id: Optional[str] = None) -> List[Dict[str, Any]]:
    """
    Fetch accumulated pilot memories for this nick + campaign.
    Returns top-N high-confidence memories, prefer nick-specific > campaign-wide > global.
    account_id is expected to be a UUID string (or None).
    """
    if not account_id and not campaign_id:
        return []

    pool = await get_pool()
    try:
        # Validate uuid-ish — if not UUID format, skip silently
        import re
        uuid_re = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', re.I)
        acc = account_id if (account_id and uuid_re.match(account_id)) else None
        cmp = campaign_id if (campaign_id and uuid_re.match(campaign_id)) else None

        # Build WHERE dynamically
        conditions = []
        params = []
        if acc:
            params.append(acc)
            conditions.append(f"account_id = ${len(params)}::uuid")
        if cmp:
            params.append(cmp)
            conditions.append(f"(campaign_id = ${len(params)}::uuid OR campaign_id IS NULL)")
        if group_fb_id:
            params.append(group_fb_id)
            conditions.append(f"(group_fb_id = ${len(params)} OR group_fb_id IS NULL)")

        if not conditions:
            return []

        params.append(MEMORY_MIN_CONFIDENCE)
        confidence_idx = len(params)
        params.append(MEMORY_LIMIT)
        limit_idx = len(params)

        query = f"""
            SELECT memory_type, key, value, confidence, evidence_count
            FROM ai_pilot_memory
            WHERE {' AND '.join(conditions)}
              AND confidence >= ${confidence_idx}
            ORDER BY confidence DESC, evidence_count DESC, last_updated_at DESC
            LIMIT ${limit_idx}
        """
        rows = await pool.fetch(query, *params)
        return [dict(r) for r in rows]
    except Exception as e:
        logger.warning('fetch_pilot_memories failed: %s', e)
        return []

async def fetch_voice_profile(account_id: Optional[str]) -> Dict[str, Any]:
    """Fetch per-nick voice profile (tone, slang, vocab, banned phrases).
    Returns {} if no profile or invalid account_id. Used to make each nick
    sound like a different person → anti-cluster signal for FB."""
    if not account_id:
        return {}
    import re
    if not re.match(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', account_id, re.I):
        return {}
    try:
        pool = await get_pool()
        row = await pool.fetchrow(
            'SELECT voice_profile FROM nick_personality WHERE account_id = $1::uuid',
            account_id,
        )
        if not row:
            return {}
        vp = row['voice_profile'] or {}
        return vp if isinstance(vp, dict) else {}
    except Exception as e:
        logger.warning('fetch_voice_profile failed: %s', e)
        return {}


# Skills that should respect per-nick voice profile (content generation only).
# Decision/scoring skills don't need voice — keep their JSON output deterministic.
VOICE_SKILLS = {'comment_gen', 'caption_gen', 'reply_gen'}


def format_voice_profile_block(vp: Dict[str, Any]) -> str:
    """Format voice profile into a natural prompt instruction block.
    Designed for content-generation skills (comment/caption/reply)."""
    if not vp or not isinstance(vp, dict):
        return ''

    lines = ['\n## Phong cách viết riêng của bạn']

    if vp.get('persona_label'):
        lines.append(f"Bạn là: **{vp['persona_label']}**")

    if vp.get('tone'):
        lines.append(f"Giọng văn: {vp['tone']}")

    if vp.get('slang_level'):
        lvl = vp['slang_level']
        slang_map = {
            'high': 'Dùng nhiều từ lóng, viết tắt như chat thật ("k", "ko", "vc", "vl", "z"...)',
            'medium': 'Có chèn từ lóng tự nhiên, không quá nhiều',
            'low': 'Hạn chế từ lóng, chỉ dùng khi cần thiết',
            'none': 'Không dùng từ lóng',
        }
        if lvl in slang_map:
            lines.append(f"Mức độ slang: {slang_map[lvl]}")

    if vp.get('emoji_freq'):
        ef = vp['emoji_freq']
        emoji_map = {
            'high': 'Hay dùng emoji (2-3/comment)',
            'medium': 'Đôi khi dùng emoji (1/comment)',
            'low': 'Hiếm khi emoji',
            'none': 'Không emoji',
        }
        if ef in emoji_map:
            lines.append(f"Emoji: {emoji_map[ef]}")

    if vp.get('vocab_examples') and isinstance(vp['vocab_examples'], list):
        lines.append(f"Từ ngữ ưa dùng: {', '.join(map(str, vp['vocab_examples'][:10]))}")

    if vp.get('banned_phrases') and isinstance(vp['banned_phrases'], list):
        lines.append(f"⚠ TUYỆT ĐỐI KHÔNG dùng: {', '.join(map(str, vp['banned_phrases'][:10]))}")

    if vp.get('interests') and isinstance(vp['interests'], list):
        lines.append(f"Sở thích / chủ đề quan tâm: {', '.join(map(str, vp['interests'][:8]))}")

    if vp.get('writing_quirks'):
        lines.append(f"Đặc điểm riêng: {vp['writing_quirks']}")

    if len(lines) == 1:
        return ''  # only header → nothing useful
    lines.append('\nViết để giống chính người này — không phải người khác.')
    return '\n'.join(lines)


def build_system_prompt(task_type: str, examples: List[Dict[str, Any]],
                        memories: Optional[List[Dict[str, Any]]] = None,
                        campaign_context: Optional[Dict[str, Any]] = None,
                        voice_profile: Optional[Dict[str, Any]] = None) -> str:
    """Combine skill prompt + campaign context + voice + few-shot examples + memories."""
    base = SKILLS.get(task_type, DEFAULT_SKILL)
    sections = [base]

    # ── Per-nick voice profile (only for content-generation skills) ──
    if voice_profile and task_type in VOICE_SKILLS:
        block = format_voice_profile_block(voice_profile)
        if block:
            sections.append(block)

    # ── Campaign context (product info + goal) ──
    if campaign_context:
        block = format_campaign_context_block(campaign_context)
        if block:
            sections.append(block)

    # ── Few-shot examples ──
    if examples:
        ex_lines = [f"{i}. {ex['output_text'][:300]}" for i, ex in enumerate(examples, 1)]
        sections.append(
            "\n## Examples of successful past outputs (reproduce this quality)\n"
            + "\n".join(ex_lines)
            + "\n\nLearn from these examples' style and tone, but do NOT copy them directly."
        )

    # ── Per-nick memory ──
    if memories:
        mem_lines = []
        for m in memories:
            val = m['value']
            # JSON value — format compactly
            if isinstance(val, dict):
                try:
                    val_str = json.dumps(val, ensure_ascii=False)[:200]
                except Exception:
                    val_str = str(val)[:200]
            else:
                val_str = str(val)[:200]
            conf = m.get('confidence', 0.5)
            mem_lines.append(f"- [{m['memory_type']}] {m['key']}: {val_str} (confidence: {conf:.2f})")

        sections.append(
            "\n## Memory for this agent (past learnings)\n"
            + "\n".join(mem_lines)
            + "\n\nThese patterns have been observed to work for this specific agent. "
            + "Prioritize them when relevant to the current task."
        )

    return "\n".join(sections)

# ── Config loader (DB-backed with TTL cache) ──────────────
async def load_config(force: bool = False) -> Dict[str, Any]:
    """Load hermes_config from DB, cached for 30s."""
    global _config_cache, _config_cache_ts
    if not force and _config_cache and (time.time() - _config_cache_ts < _CONFIG_CACHE_TTL):
        return _config_cache
    try:
        pool = await get_pool()
        row = await pool.fetchrow('SELECT config FROM hermes_config WHERE id = 1')
        _config_cache = dict(row['config']) if row else {}
    except Exception as e:
        logger.warning('load_config failed, using defaults: %s', e)
        _config_cache = {}
    _config_cache_ts = time.time()
    return _config_cache

def _cfg_get(cfg: Dict, key: str, default: Any) -> Any:
    v = cfg.get(key)
    return v if v is not None else default

# ── LLM call with stats recording ─────────────────────────
def _resolve_model(task_type: str, cfg: Dict[str, Any]) -> str:
    """Select model for this task_type. User-explicit settings beat hardcoded
    tier defaults — otherwise switching provider in UI silently does nothing
    because TIER_DEFAULTS still names DeepSeek models.

    Priority:
      1. cfg.skill_models[task_type]   — per-skill override (most specific)
      2. cfg.tier_models[tier]         — per-tier override
      3. cfg.model                     — user-set global model (UI Hermes Config → Model)
      4. TIER_DEFAULTS[tier]           — built-in default for the tier
      5. MODEL env                     — last-resort fallback
    """
    # 1. Per-skill override
    skill_models = cfg.get('skill_models') or {}
    if isinstance(skill_models, dict) and task_type in skill_models:
        return skill_models[task_type]
    # 2. Per-tier override
    tier = SKILL_TIERS.get(task_type, 'balanced')
    tier_models = cfg.get('tier_models') or {}
    if isinstance(tier_models, dict) and tier in tier_models:
        return tier_models[tier]
    # 3. User-set global model — must beat TIER_DEFAULTS which is hardcoded
    #    to DeepSeek model names. Without this, picking Kimi in UI sends Kimi
    #    requests asking for "deepseek-chat" → 404 Not Found.
    cfg_model = cfg.get('model')
    if cfg_model:
        return cfg_model
    # 4. Built-in tier default
    tier_default = TIER_DEFAULTS.get(tier)
    if tier_default:
        return tier_default
    # 5. Env fallback
    return MODEL


# ─── Provider fallback chain (2026-05-02) ──────────────────────
# When the primary provider hits 429 / 5xx / billing failures, transparently
# retry through DeepSeek → Gemini 2.5 Flash. Keys come from env so adding /
# rotating fallback keys doesn't require a hermes_config DB write.
#
# Circuit breaker: any provider that returns 401/402/insufficient is marked
# dead for 5 minutes — subsequent calls skip it instead of paying latency for
# a known-broken provider.
_dead_providers: Dict[str, float] = {}
_DEAD_BREAKER_TTL = 5 * 60  # seconds

def _is_provider_dead(name: str) -> bool:
    if name in _dead_providers:
        if time.time() < _dead_providers[name]:
            return True
        del _dead_providers[name]
    return False

def _mark_provider_dead(name: str):
    _dead_providers[name] = time.time() + _DEAD_BREAKER_TTL

# Fallback definitions. Each entry: (name, env vars for key in priority
# order, base_url, model). Order matters: tried left-to-right after primary
# fails. Multiple env var names supported because legacy code uses
# OPENAI_API_KEY for DeepSeek (codebase convention pre-2026).
PROVIDER_CONFIG = {
    "nvidia": {
        "base_url": "https://integrate.api.nvidia.com/v1",
        "api_key_env": "NVIDIA_API_KEY",
        "compat": "openai",
    },
    "groq": {
        "base_url": "https://api.groq.com/openai/v1",
        "api_key_env": "GROQ_API_KEY",
        "compat": "openai",
    },
    "deepseek": {
        "base_url": "https://api.deepseek.com/v1",
        "api_key_env": "DEEPSEEK_API_KEY",
        "compat": "openai",
    },
    "kimi": {
        "base_url": "https://api.moonshot.cn/v1",
        "api_key_env": "KIMI_API_KEY",
        "compat": "openai",
    },
    "openai": {
        "base_url": "https://api.openai.com/v1",
        "api_key_env": "OPENAI_API_KEY",
        "compat": "openai",
    },
    "gemini": {
        "base_url": "https://generativelanguage.googleapis.com/v1beta/openai/",
        "api_key_env": "GEMINI_API_KEY",
        "compat": "openai",
    },
    "anthropic": {
        "base_url": "https://api.anthropic.com/v1",
        "api_key_env": "ANTHROPIC_API_KEY",
        "compat": "anthropic",
    },
}

DEFAULT_FALLBACK_CHAIN = [
    {"provider": "nvidia",    "model": "meta/llama-3.3-70b-instruct",  "enabled": True},
    {"provider": "groq",      "model": "llama-3.3-70b-versatile",      "enabled": True},
    {"provider": "deepseek",  "model": "deepseek-chat",                "enabled": True},
    {"provider": "openai",    "model": "gpt-4o-mini",                  "enabled": False},
    {"provider": "gemini",    "model": "gemini-2.5-flash",             "enabled": False},
    {"provider": "kimi",      "model": "moonshot-v1-128k",             "enabled": False},
    {"provider": "anthropic", "model": "claude-sonnet-4-6",            "enabled": False},
]

def mask_api_key(key: str) -> str:
    if not key:
        return ""
    key = key.strip()
    if len(key) < 12:
        return "***"
    return key[:6] + "..." + key[-4:]

def is_masked(value: str) -> bool:
    if not value:
        return False
    return "..." in value and len(value) < 20

def _extract_status(err: Exception) -> Optional[int]:
    """Extract HTTP status code from exception."""
    code = getattr(err, 'status_code', None) or getattr(err, 'code', None)
    if isinstance(code, int):
        return code
    msg = str(err)
    for s in (429, 401, 402, 500, 502, 503, 504):
        if str(s) in msg[:80]:
            return s
    return None

def _call_provider(
    compat: str,
    base_url: str,
    api_key: str,
    model: str,
    messages: list,
    max_tokens: int,
    temperature: float,
    **kwargs
) -> str:
    if compat == "anthropic":
        from anthropic import Anthropic
        system_content = ""
        user_messages = []
        for msg in messages:
            if msg.get('role') == 'system':
                system_content = msg.get('content', '')
            else:
                user_messages.append({'role': msg.get('role'), 'content': msg.get('content', '')})
        
        client_kwargs = {}
        if base_url:
            client_kwargs['base_url'] = base_url
        client = Anthropic(api_key=api_key, **client_kwargs)
        
        resp = client.messages.create(
            model=model,
            system=system_content,
            messages=user_messages,
            max_tokens=max_tokens,
            temperature=temperature,
        )
        return resp.content[0].text.strip()
    else:
        from openai import OpenAI
        client = OpenAI(api_key=api_key, base_url=base_url)
        
        model_lower = (model or '').lower()
        fixed_temp_patterns = ('o1-', 'o3-', 'o4-', 'gpt-5', '-thinking', 'reasoner')
        eff_temp = 1.0 if any(p in model_lower for p in fixed_temp_patterns) else temperature
        
        def _do(temp_override=None, max_tokens_param='max_tokens'):
            do_kwargs = {
                'model': model,
                'messages': messages,
                'temperature': temp_override if temp_override is not None else eff_temp,
            }
            do_kwargs[max_tokens_param] = max_tokens
            return client.chat.completions.create(**do_kwargs)
        
        try:
            resp = _do()
        except Exception as inner:
            msg = str(inner).lower()
            if 'temperature' in msg and ('only 1' in msg or 'must be 1' in msg or 'invalid temperature' in msg):
                logger.warning('Model %s requires temperature=1, retrying', model)
                resp = _do(temp_override=1.0)
            elif 'max_tokens' in msg and 'max_completion_tokens' in msg:
                logger.warning('Model %s requires max_completion_tokens, retrying', model)
                resp = _do(max_tokens_param='max_completion_tokens')
            else:
                raise
        return (resp.choices[0].message.content or '').strip()

FALLBACK_TRIGGER_STATUS = {401, 402, 403, 429, 500, 502, 503, 504}

def call_with_fallback(
    messages: list,
    config: dict,
    fallback_keys: dict,
    max_tokens: int = 500,
    temperature: float = 0.7,
    task_type: str = 'generic',
    **kwargs
) -> str:
    """
    Thử lần lượt các provider trong fallback_chain.
    Chỉ chuyển provider khi gặp 429/5xx/timeout.
    Raise exception nếu TẤT CẢ provider đều fail.
    """
    chain = config.get("fallback_chain") or DEFAULT_FALLBACK_CHAIN
    active_chain = [p for p in chain if p.get("enabled")]

    model_override = kwargs.get("model_override")
    if model_override and ":" in model_override:
        parts = model_override.split(":", 1)
        prov, mdl = parts[0], parts[1]
        override_item = {"provider": prov, "model": mdl, "enabled": True}
        active_chain = [override_item] + [p for p in active_chain if not (p.get("provider") == prov and p.get("model") == mdl)]


    last_error = None

    for i, provider_cfg in enumerate(active_chain):
        provider = provider_cfg["provider"]
        model    = provider_cfg["model"]
        pconfig  = PROVIDER_CONFIG.get(provider)
        if not pconfig:
            logger.warning(f"[Fallback] Skip {provider}: unknown provider config")
            continue

        api_key_env = pconfig["api_key_env"]
        api_key = (fallback_keys or {}).get(api_key_env)
        if not api_key:
            if config.get("provider") == provider:
                api_key = config.get("api_key")
        if not api_key:
            api_key = os.getenv(api_key_env)

        api_key = (api_key or "").strip()
        if not api_key:
            logger.warning(f"[Fallback] Skip {provider}: no API key configured")
            continue

        base_url = pconfig["base_url"]
        compat = pconfig["compat"]

        try:
            logger.info(f"[Fallback] Attempt {i+1}/{len(active_chain)}: {provider} / {model}")
            result = _call_provider(
                compat=compat,
                base_url=base_url,
                api_key=api_key,
                model=model,
                messages=messages,
                max_tokens=max_tokens,
                temperature=temperature,
                **kwargs
            )
            if i > 0:
                logger.info(f"[Fallback] Succeeded on provider #{i+1}: {provider}")
            return result

        except Exception as e:
            status_code = _extract_status(e)
            
            is_fallback_trigger = False
            if status_code in FALLBACK_TRIGGER_STATUS:
                is_fallback_trigger = True
            
            err_name = e.__class__.__name__
            err_str = str(e).lower()
            
            try:
                import httpx
                if isinstance(e, (httpx.TimeoutException, httpx.ConnectError)):
                    is_fallback_trigger = True
            except ImportError:
                pass
            
            try:
                from openai import APITimeoutError, APIConnectionError
                if isinstance(e, (APITimeoutError, APIConnectionError)):
                    is_fallback_trigger = True
            except ImportError:
                pass
            
            if "timeout" in err_str or "timed out" in err_str or "connection" in err_str or "connect error" in err_str:
                is_fallback_trigger = True
            
            if status_code in {400}:
                is_fallback_trigger = False
                
            if is_fallback_trigger:
                logger.warning(
                    f"[Fallback] {provider} failed (status={status_code}, error={e}), "
                    f"trying next provider..."
                )
                last_error = e
                continue
            else:
                raise

    raise RuntimeError(
        f"All providers in fallback_chain failed. Last error: {last_error}"
    )

def llm_call(system_prompt: str, user_message: str, max_tokens: int = 500, temperature: float = 0.7,
             cfg: Optional[Dict[str, Any]] = None, task_type: str = 'generic') -> str:
    """Call LLM with automatic fallback chain."""
    config = cfg or {}
    messages = [
        {'role': 'system', 'content': system_prompt},
        {'role': 'user', 'content': user_message}
    ]
    fallback_keys = config.get('fallback_keys') or {}
    try:
        return call_with_fallback(
            messages=messages,
            config=config,
            fallback_keys=fallback_keys,
            max_tokens=max_tokens,
            temperature=temperature,
            task_type=task_type
        )
    except Exception as e:
        err_str = str(e).encode('utf-8', errors='replace').decode('utf-8')
        logger.error('All LLM providers failed. Last error: %s', err_str[:300])
        raise HTTPException(502, 'LLM call failed: ' + err_str)

async def record_call(task_type: str, prompt: str, output: str, latency_ms: int,
                      ok: bool, account_id: Optional[str] = None, error: Optional[str] = None):
    """Persist call to DB. Never raises — failure to record must not break the call."""
    try:
        pool = await get_pool()
        await pool.execute(
            """
            INSERT INTO hermes_calls (task_type, prompt_preview, output_preview, latency_ms, ok, error_message, account_id)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            """,
            task_type, (prompt or '')[:500], (output or '')[:500], latency_ms, ok, error, account_id,
        )
    except Exception as e:
        logger.warning('record_call failed: %s', e)

# ── Core AI call wrapper (few-shot + memory aware) ────────
async def ai_call(task_type: str, user_prompt: str, max_tokens: int, temperature: float,
                  account_id: Optional[str] = None, campaign_id: Optional[str] = None,
                  group_fb_id: Optional[str] = None, extra_system: str = '') -> Dict[str, Any]:
    """Main entry point used by all task endpoints.
    Injects few-shot examples + per-nick memories before calling DeepSeek.
    Respects runtime config toggles (fewshot_enabled, memory_enabled)."""
    cfg = await load_config()
    fewshot_enabled = cfg.get('fewshot_enabled', True)
    memory_enabled = cfg.get('memory_enabled', True)
    # Update min score from config
    global FEWSHOT_MIN_SCORE
    FEWSHOT_MIN_SCORE = cfg.get('fewshot_min_score', 4)

    # Fetch in parallel for speed (or skip if toggles off)
    examples_coro = fetch_fewshot_examples(task_type, account_id) if fewshot_enabled else asyncio.sleep(0, result=[])
    memories_coro = fetch_pilot_memories(account_id, campaign_id, group_fb_id) if memory_enabled else asyncio.sleep(0, result=[])
    context_coro = fetch_campaign_context(campaign_id)
    voice_coro = fetch_voice_profile(account_id) if task_type in VOICE_SKILLS else asyncio.sleep(0, result={})
    examples, memories, campaign_ctx, voice_profile = await asyncio.gather(
        examples_coro, memories_coro, context_coro, voice_coro
    )

    system_prompt = build_system_prompt(task_type, examples, memories, campaign_ctx, voice_profile)
    if extra_system:
        system_prompt = system_prompt + '\n\n' + extra_system

    t0 = time.time()
    resolved_model = _resolve_model(task_type, cfg)
    tier = SKILL_TIERS.get(task_type, 'balanced')
    try:
        text = llm_call(system_prompt, user_prompt, max_tokens, temperature, cfg, task_type)
        latency_ms = int((time.time() - t0) * 1000)
        await record_call(task_type, user_prompt, text, latency_ms, True, account_id)
        ctx_tag = ''
        if campaign_ctx and (campaign_ctx.get('goal') or campaign_ctx.get('hermes_context')):
            cn = campaign_ctx.get('name', '')[:20].replace(' ', '_').lower()
            ctx_tag = f' context={cn}'
        voice_tag = ''
        if voice_profile and isinstance(voice_profile, dict) and voice_profile.get('persona_label'):
            voice_tag = f' voice={voice_profile["persona_label"][:20]}'
        logger.info('[HERMES] task=%s tier=%s model=%s account=%s%s%s mem=%d ex=%d lat=%dms',
                    task_type, tier, resolved_model, (account_id or 'none')[:8],
                    ctx_tag, voice_tag, len(memories), len(examples), int((time.time() - t0) * 1000))
        return {
            'text': text,
            'latency_ms': latency_ms,
            'fewshot_count': len(examples),
            'memory_count': len(memories),
            'has_campaign_context': bool(campaign_ctx and (campaign_ctx.get('goal') or campaign_ctx.get('hermes_context'))),
            'fewshot_sources': [{'score': ex['score']} for ex in examples],
            'model': resolved_model,
            'tier': tier,
        }
    except Exception as e:
        latency_ms = int((time.time() - t0) * 1000)
        await record_call(task_type, user_prompt, '', latency_ms, False, account_id, str(e)[:500])
        raise

# ── Pydantic models ───────────────────────────────────────
class GenerateRequest(BaseModel):
    messages: Optional[List[Dict[str, Any]]] = None
    prompt: Optional[str] = None
    task_type: str = 'generic'
    context: Optional[Dict[str, Any]] = None
    max_tokens: Optional[int] = None
    temperature: Optional[float] = None
    function_name: Optional[str] = None
    account_id: Optional[str] = None
    campaign_id: Optional[str] = None
    group_fb_id: Optional[str] = None

class CommentRequest(BaseModel):
    post_snippet: str
    group_name: str = ''
    topic: str = ''
    style: str = 'casual'
    language: str = 'vi'
    context: str = ''
    brand_config: Optional[Dict] = None
    account_id: Optional[str] = None
    campaign_id: Optional[str] = None
    group_fb_id: Optional[str] = None

class EvaluateRequest(BaseModel):
    posts: List[Dict[str, Any]]
    topic: str = ''
    campaign_goal: str = ''
    language: str = 'vi'
    account_id: Optional[str] = None
    campaign_id: Optional[str] = None
    group_fb_id: Optional[str] = None

class QualityGateRequest(BaseModel):
    comment: str
    post_snippet: str
    language: str = 'vi'
    account_id: Optional[str] = None
    campaign_id: Optional[str] = None

class FeedbackRequest(BaseModel):
    task_type: str
    output_text: str
    score: int
    account_id: Optional[str] = None
    context: Optional[Dict] = None
    reason: Optional[str] = None
    prompt: Optional[str] = None

class SkillUpdateRequest(BaseModel):
    content: str

# ── Health ────────────────────────────────────────────────
@app.get('/health')
async def health():
    import json
    auth_info = None
    for p in ['/root/.hermes/auth.json', os.path.expanduser('~/.hermes/auth.json')]:
        if os.path.exists(p):
            try:
                with open(p, 'r', encoding='utf-8') as f:
                    auth_info = json.load(f)
                    break
            except Exception as e:
                auth_info = {'error': str(e)}
    cfg = await load_config()
    current_model = cfg.get('model') or MODEL
    return {
        'status': 'ok',
        'model': current_model,
        'skills': sorted(SKILLS.keys()),
        'task_types': sorted(TASK_CONFIG.keys()),
        'version': '2.0.0',
        'features': ['persistent_feedback', 'few_shot_injection', 'skill_crud', 'hot_reload'],
        'auth_info': auth_info,
    }

# ── Status / Performance (DB-backed) ──────────────────────
@app.get('/status')
async def status(x_agent_key: str = Header(None)):
    verify_key(x_agent_key)
    pool = await get_pool()
    cfg = await load_config()
    current_model = cfg.get('model') or MODEL
    try:
        row = await pool.fetchrow("""
            SELECT
              COUNT(*) AS total_calls,
              COUNT(*) FILTER (WHERE NOT ok) AS total_errors,
              COUNT(*) FILTER (WHERE created_at > now() - INTERVAL '1 hour') AS calls_last_hour,
              COUNT(DISTINCT task_type) FILTER (WHERE ok) AS task_types_active
            FROM hermes_calls
        """)
        avg_row = await pool.fetchrow("""
            SELECT AVG(score)::float AS avg_score, COUNT(DISTINCT account_id) AS active_agents
            FROM hermes_feedback
            WHERE created_at > now() - INTERVAL '7 days'
        """)
    except Exception as e:
        logger.warning('status query failed: %s', e)
        return {'status': 'DEGRADED', 'error': str(e)[:200]}

    return {
        'status': 'ONLINE',
        'model': current_model,
        'total_calls': row['total_calls'] or 0,
        'total_errors': row['total_errors'] or 0,
        'calls_last_hour': row['calls_last_hour'] or 0,
        'avg_score': round(avg_row['avg_score'] or 0.0, 2),
        'active_agents': avg_row['active_agents'] or 0,
        'task_types_active': row['task_types_active'] or 0,
    }

@app.get('/performance')
async def performance(x_agent_key: str = Header(None)):
    verify_key(x_agent_key)
    pool = await get_pool()

    skill_rows = await pool.fetch("""
        SELECT
          c.task_type,
          COUNT(*) AS count,
          COUNT(*) FILTER (WHERE NOT c.ok) AS errors,
          AVG(c.latency_ms)::int AS avg_latency_ms
        FROM hermes_calls c
        GROUP BY c.task_type
        ORDER BY count DESC
    """)
    feedback_rows = await pool.fetch("""
        SELECT task_type, AVG(score)::float AS avg_score, COUNT(*) AS examples
        FROM hermes_feedback
        GROUP BY task_type
    """)
    feedback_map = {r['task_type']: r for r in feedback_rows}

    skills = []
    for r in skill_rows:
        fb = feedback_map.get(r['task_type'])
        skills.append({
            'task_type': r['task_type'],
            'count': r['count'] or 0,
            'errors': r['errors'] or 0,
            'avg_latency_ms': r['avg_latency_ms'] or 0,
            'avg_score': round(fb['avg_score'] or 0.0, 2) if fb else 0.0,
            'examples': fb['examples'] if fb else 0,
        })

    # Recent calls feed
    recent_rows = await pool.fetch("""
        SELECT task_type, prompt_preview, output_preview, latency_ms, ok, account_id,
               EXTRACT(EPOCH FROM created_at)::float AS ts
        FROM hermes_calls
        ORDER BY created_at DESC
        LIMIT 50
    """)
    recent = [dict(r) for r in recent_rows]
    # Rename for FE compat
    for c in recent:
        c['prompt'] = c.pop('prompt_preview') or ''
        c['output'] = c.pop('output_preview') or ''

    return {'skills': skills, 'recent_calls': recent}

@app.get('/skills/status')
async def skills_status(x_agent_key: str = Header(None)):
    verify_key(x_agent_key)
    pool = await get_pool()
    call_rows = await pool.fetch("""
        SELECT task_type, COUNT(*) AS count, MAX(EXTRACT(EPOCH FROM created_at))::float AS last_call
        FROM hermes_calls
        GROUP BY task_type
    """)
    call_map = {r['task_type']: r for r in call_rows}

    fb_rows = await pool.fetch("""
        SELECT task_type, AVG(score)::float AS avg_score, COUNT(*) AS examples_count
        FROM hermes_feedback
        GROUP BY task_type
    """)
    fb_map = {r['task_type']: r for r in fb_rows}

    result = []
    for task_type, prompt_text in SKILLS.items():
        call = call_map.get(task_type, {})
        fb = fb_map.get(task_type, {})
        file_path = SKILL_FILES.get(task_type)
        result.append({
            'task_type': task_type,
            'skill_loaded': len(prompt_text) > 0,
            'skill_length': len(prompt_text),
            'file_path': str(file_path) if file_path else None,
            'calls': call.get('count', 0),
            'avg_score': round(fb.get('avg_score') or 0.0, 2),
            'examples_count': fb.get('examples_count', 0),
            'last_call_ts': call.get('last_call'),
        })
    return {'skills': result}

# ── Feedback endpoints (DB-backed) ────────────────────────
@app.post('/feedback')
async def feedback(req: FeedbackRequest, x_agent_key: str = Header(None)):
    verify_key(x_agent_key)
    if not 1 <= req.score <= 5:
        raise HTTPException(400, 'score must be 1-5')
    pool = await get_pool()
    try:
        row = await pool.fetchrow(
            """
            INSERT INTO hermes_feedback (task_type, prompt, output_text, score, account_id, reason, context)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            RETURNING id, created_at
            """,
            req.task_type, (req.prompt or '')[:2000], req.output_text[:2000],
            req.score, req.account_id, req.reason,
            json.dumps(req.context) if req.context else None,
        )
    except Exception as e:
        logger.error('feedback insert failed: %s', e)
        raise HTTPException(500, 'DB insert failed')
    return {'ok': True, 'id': row['id'], 'recorded_at': row['created_at'].timestamp()}

@app.get('/feedback/recent')
async def recent_feedback(limit: int = 50, x_agent_key: str = Header(None)):
    verify_key(x_agent_key)
    pool = await get_pool()
    rows = await pool.fetch(
        """
        SELECT id, task_type, score, account_id, reason, output_text,
               EXTRACT(EPOCH FROM created_at)::float AS ts
        FROM hermes_feedback
        ORDER BY created_at DESC
        LIMIT $1
        """,
        min(limit, 200),
    )
    return {'feedback': [
        {**dict(r), 'output_preview': r['output_text'][:200]} for r in rows
    ]}

# ── Main generation endpoints (with few-shot) ─────────────
@app.post('/generate')
async def generate(req: GenerateRequest, x_agent_key: str = Header(None)):
    verify_key(x_agent_key)
    task_type = req.task_type or req.function_name or 'generic'
    default_max, default_temp = TASK_CONFIG.get(task_type, (500, 0.7))

    # Resolve user message
    if req.messages:
        user = next((m['content'] for m in req.messages if m.get('role') == 'user'), '')
    else:
        user = req.prompt or ''

    if req.context:
        user = user + '\n\nContext: ' + json.dumps(req.context, ensure_ascii=False)

    if not user:
        raise HTTPException(400, 'Either messages or prompt is required')

    result = await ai_call(
        task_type=task_type,
        user_prompt=user,
        max_tokens=req.max_tokens or default_max,
        temperature=req.temperature if req.temperature is not None else default_temp,
        account_id=req.account_id,
        campaign_id=req.campaign_id,
        group_fb_id=req.group_fb_id,
    )
    return {
        'text': result['text'],
        'task_type': task_type,
        'provider': 'hermes',
        'model': result.get('model', MODEL),
        'tier': result.get('tier', 'balanced'),
        'fewshot_count': result['fewshot_count'],
        'memory_count': result['memory_count'],
    }

@app.post('/comment')
async def generate_comment(req: CommentRequest, x_agent_key: str = Header(None)):
    verify_key(x_agent_key)

    extra = ''
    if req.brand_config:
        bn = req.brand_config.get('brand_name', '')
        bv = req.brand_config.get('brand_voice', 'casual')
        be = req.brand_config.get('example_comment', '')
        extra = (
            '\n\nBrand integration (subtle, max 1 mention):\n'
            'Brand: ' + bn + '\nVoice: ' + bv + '\nExample: ' + be
        )

    ctx_line = 'Context: ' + req.context if req.context else ''
    user = (
        'Post from group "' + req.group_name + '" (topic: ' + req.topic + '):\n'
        '---\n' + req.post_snippet[:500] + '\n---\n'
        + ctx_line + '\n'
        'Style: ' + req.style + ' | Language: ' + req.language + '\n'
        'Generate ONE comment:'
    )

    result = await ai_call('comment_gen', user, 350, 0.85,
                            account_id=req.account_id, campaign_id=req.campaign_id,
                            group_fb_id=req.group_fb_id, extra_system=extra)
    text = result['text'].strip().strip('"').strip("'").strip()
    if text.startswith('```'):
        inner = text[3:]
        text = (inner.split('```')[0] if '```' in inner else inner).strip()

    return {
        'comment': text, 'task_type': 'comment_gen', 'provider': 'hermes',
        'model': result.get('model', MODEL), 'fewshot_count': result['fewshot_count'],
        'memory_count': result['memory_count'],
    }

@app.post('/evaluate')
async def evaluate_posts(req: EvaluateRequest, x_agent_key: str = Header(None)):
    verify_key(x_agent_key)

    posts_text = ''
    for i, p in enumerate(req.posts[:15]):
        text = p.get('text', '')[:300]
        author = p.get('author', 'unknown')
        reactions = p.get('reactions', 0)
        posts_text += '[' + str(i) + '] by ' + author + ' (' + str(reactions) + ' reactions): ' + text + '\n---\n'

    user = (
        'Campaign topic: ' + req.topic + '\nGoal: ' + req.campaign_goal + '\n'
        'Language: ' + req.language + '\n\nEvaluate these posts and return JSON array:\n' + posts_text
    )

    result = await ai_call('post_eval', user, 1500, 0.1,
                            account_id=req.account_id, campaign_id=req.campaign_id,
                            group_fb_id=req.group_fb_id)
    text = result['text']

    try:
        scores = json.loads(text[text.index('['):text.rindex(']') + 1]) if '[' in text else json.loads(text)
    except Exception:
        scores = []

    return {
        'scores': scores, 'task_type': 'post_eval', 'provider': 'hermes',
        'model': result.get('model', MODEL), 'fewshot_count': result['fewshot_count'],
        'memory_count': result['memory_count'],
    }

@app.post('/quality-gate')
async def quality_gate(req: QualityGateRequest, x_agent_key: str = Header(None)):
    verify_key(x_agent_key)

    user = (
        'Post: ' + req.post_snippet[:300] + '\n'
        'Comment to validate: "' + req.comment + '"\n'
        'Language: ' + req.language + '\n\n'
        'Return JSON: {"score": N, "pass": bool, "reason": "...", "suggestion": "..."}'
    )

    result = await ai_call('quality_gate', user, 200, 0.1,
                            account_id=req.account_id, campaign_id=req.campaign_id)
    text = result['text']

    try:
        parsed = json.loads(text[text.index('{'):text.rindex('}') + 1]) if '{' in text else json.loads(text)
    except Exception:
        parsed = {'score': 6, 'pass': True, 'reason': 'Parse error, defaulting to pass'}

    return {
        **parsed, 'task_type': 'quality_gate', 'provider': 'hermes',
        'model': result.get('model', MODEL), 'fewshot_count': result['fewshot_count'],
        'memory_count': result['memory_count'],
    }

# ── Skill CRUD endpoints ──────────────────────────────────
@app.get('/skills')
async def list_skills(x_agent_key: str = Header(None)):
    verify_key(x_agent_key)
    result = []
    for task_type, prompt_text in SKILLS.items():
        f = SKILL_FILES.get(task_type)
        result.append({
            'task_type': task_type,
            'content_length': len(prompt_text),
            'file_path': str(f) if f else None,
            'editable': f is not None,
            'preview': prompt_text[:200],
        })
    return {'skills': result, 'skills_dirs': [str(d) for d in SKILLS_DIRS]}

@app.get('/skills/{task_type}')
async def get_skill(task_type: str, x_agent_key: str = Header(None)):
    verify_key(x_agent_key)
    if task_type not in SKILLS:
        raise HTTPException(404, f'Unknown task_type: {task_type}')
    f = SKILL_FILES.get(task_type)
    return {
        'task_type': task_type,
        'content': SKILLS[task_type],
        'file_path': str(f) if f else None,
        'editable': f is not None,
        'aliases': TASK_ALIASES.get(task_type, []),
    }

@app.put('/skills/{task_type}')
async def update_skill(task_type: str, req: SkillUpdateRequest, x_agent_key: str = Header(None)):
    verify_key(x_agent_key)
    if task_type not in TASK_ALIASES:
        raise HTTPException(404, f'Unknown task_type: {task_type}')

    # Resolve target file: existing file, or create new in PRIMARY_SKILL_DIR
    f = SKILL_FILES.get(task_type)
    if f is None:
        # Create new file using first alias name
        alias = TASK_ALIASES[task_type][0]
        f = PRIMARY_SKILL_DIR / f"{alias}.md"

    # Validate content
    content = (req.content or '').strip()
    if len(content) < 10:
        raise HTTPException(400, 'Content too short (min 10 chars)')
    if len(content) > 50000:
        raise HTTPException(400, 'Content too long (max 50000 chars)')

    # Write with frontmatter preserved if original had one
    try:
        original = f.read_text(encoding='utf-8') if f.exists() else ''
        frontmatter = ''
        if original.startswith('---'):
            parts = original.split('---', 2)
            if len(parts) >= 3:
                frontmatter = '---' + parts[1] + '---\n\n'

        final = frontmatter + content + '\n' if frontmatter else content + '\n'
        f.write_text(final, encoding='utf-8')

        # Hot-reload into memory
        SKILLS[task_type] = content
        SKILL_FILES[task_type] = f
        logger.info('Skill updated: %s (%d chars) → %s', task_type, len(content), f)
    except Exception as e:
        logger.error('Skill write failed: %s', e)
        raise HTTPException(500, f'Write failed: {e}')

    return {
        'ok': True,
        'task_type': task_type,
        'file_path': str(f),
        'content_length': len(content),
    }

@app.post('/skills/reload')
async def reload_skills(x_agent_key: str = Header(None)):
    verify_key(x_agent_key)
    load_all_skills()
    return {
        'ok': True,
        'skills_loaded': {k: len(v) for k, v in SKILLS.items() if v},
    }

# ── Skill create + delete ─────────────────────────────────
class SkillCreateRequest(BaseModel):
    task_type: str
    content: str

@app.post('/skills')
async def create_skill(req: SkillCreateRequest, x_agent_key: str = Header(None)):
    verify_key(x_agent_key)
    import re as _re
    if not _re.match(r'^[a-z][a-z0-9_]{2,40}$', req.task_type):
        raise HTTPException(400, 'task_type must be lowercase snake_case (3-40 chars)')
    if req.task_type in SKILLS and SKILLS[req.task_type]:
        raise HTTPException(409, f'Skill {req.task_type} already exists — use PUT to update')
    if len(req.content) < 10 or len(req.content) > 50000:
        raise HTTPException(400, 'content length 10-50000')

    # Create file + register alias
    filename = req.task_type.replace('_', '-') + '.md'
    fpath = PRIMARY_SKILL_DIR / filename
    try:
        fpath.write_text(req.content.strip() + '\n', encoding='utf-8')
        # Add to aliases + task config if not exists
        if req.task_type not in TASK_ALIASES:
            TASK_ALIASES[req.task_type] = [req.task_type.replace('_', '-')]
        if req.task_type not in TASK_CONFIG:
            TASK_CONFIG[req.task_type] = (500, 0.7)
        load_all_skills()
    except Exception as e:
        raise HTTPException(500, f'Create failed: {e}')
    return {'ok': True, 'task_type': req.task_type, 'file_path': str(fpath)}

@app.delete('/skills/{task_type}')
async def delete_skill(task_type: str, x_agent_key: str = Header(None)):
    verify_key(x_agent_key)
    # Never delete core skills
    CORE = {'comment_gen', 'quality_gate', 'post_eval', 'reply_gen', 'action_decision',
            'relevance_score', 'lead_score', 'caption_gen', 'content_eval'}
    if task_type in CORE:
        raise HTTPException(400, f'Cannot delete core skill {task_type} — edit instead')
    f = SKILL_FILES.get(task_type)
    if not f or not f.exists():
        raise HTTPException(404, 'Skill file not found')
    try:
        f.unlink()
        SKILLS.pop(task_type, None)
        SKILL_FILES.pop(task_type, None)
        TASK_ALIASES.pop(task_type, None)
        TASK_CONFIG.pop(task_type, None)
    except Exception as e:
        raise HTTPException(500, f'Delete failed: {e}')
    return {'ok': True, 'deleted': task_type}

# ── Config CRUD ───────────────────────────────────────────
class FallbackProvider(BaseModel):
    provider: str      # "nvidia" | "groq" | "deepseek" | "kimi" | "openai" | "gemini" | "anthropic"
    model: str         # model ID tương ứng provider
    enabled: bool = True

# Add WordPress Client and HTML parser
try:
    from wp_client import WordPressClient
    from bs4 import BeautifulSoup
except ImportError:
    pass

class ConfigUpdateRequest(BaseModel):
    provider: Optional[str] = None
    model: Optional[str] = None
    api_key: Optional[str] = None
    base_url: Optional[str] = None
    max_tokens: Optional[int] = None
    temperature: Optional[float] = None
    quality_gate_threshold: Optional[int] = None
    quality_gate_max_retry: Optional[int] = None
    fallback_keys: Optional[Dict[str, str]] = None
    fallback_chain: Optional[List[FallbackProvider]] = None
    fallback_timeout_ms: Optional[int] = None
    fewshot_enabled: Optional[bool] = None
    memory_enabled: Optional[bool] = None
    fewshot_min_score: Optional[int] = None
    # Per-tier model routing: {"fast": "deepseek-chat", "balanced": "deepseek-chat", "smart": "deepseek-reasoner"}
    tier_models: Optional[Dict[str, str]] = None
    # Per-skill model override: {"orchestrator": "anthropic/claude-sonnet-4-5", "comment_gen": "deepseek-chat"}
    skill_models: Optional[Dict[str, str]] = None
    gpt_link: Optional[str] = None
    # WordPress config fields
    wp_url: Optional[str] = None
    wp_username: Optional[str] = None
    wp_app_password: Optional[str] = None
    wp_token: Optional[str] = None  # username:app_password (plain or base64)
    wp_sites: Optional[list] = None  # [{name, url, token}, ...] multi-site support
    wp_rest_base: Optional[str] = None
    pillar_map: Optional[Dict[str, dict]] = None
    # Google Analytics & Search Console config fields
    gsc_site_url: Optional[str] = None
    gsc_credentials_json: Optional[str] = None
    ga4_property_id: Optional[str] = None
    ga4_credentials_json: Optional[str] = None
    analytics_cache_hours: Optional[int] = None

@app.get('/config')
async def get_config(x_agent_key: str = Header(None)):
    verify_key(x_agent_key)
    cfg = await load_config(force=True)
    # Mask API key in response
    safe = dict(cfg)
    if safe.get('api_key'):
        safe['api_key'] = mask_api_key(safe['api_key'])
    if safe.get('fallback_keys') and isinstance(safe['fallback_keys'], dict):
        safe['fallback_keys'] = {
            k: mask_api_key(v) for k, v in safe['fallback_keys'].items()
        }
    if safe.get('wp_app_password'):
        safe['wp_app_password'] = mask_api_key(safe['wp_app_password'])
    if safe.get('wp_token'):
        safe['wp_token'] = mask_api_key(safe['wp_token'])
    if safe.get('gsc_credentials_json'):
        safe['gsc_credentials_json'] = mask_api_key(safe['gsc_credentials_json'])
    if safe.get('ga4_credentials_json'):
        safe['ga4_credentials_json'] = mask_api_key(safe['ga4_credentials_json'])
    if safe.get('wp_sites') and isinstance(safe['wp_sites'], list):
        safe['wp_sites'] = [
            {**s, 'token': mask_api_key(s.get('token', ''))} if s.get('token') else s
            for s in safe['wp_sites']
        ]
    # Effective routing: what model each skill actually uses right now
    effective_routing = {}
    for task_type, tier in SKILL_TIERS.items():
        effective_routing[task_type] = {
            'tier': tier,
            'model': _resolve_model(task_type, cfg),
        }

    return {
        'config': safe,
        'providers': {p: {
            'base_url': v['base_url'],
            'models': v['models'],
            'label': v.get('label', p),
            'allow_custom_model': v.get('allow_custom_model', True),
        } for p, v in PROVIDERS.items()},
        'api_key_set': bool(cfg.get('api_key') or DEEPSEEK_KEY),
        'skill_tiers': SKILL_TIERS,
        'tier_defaults': TIER_DEFAULTS,
        'effective_routing': effective_routing,
    }

@app.put('/config')
async def update_config(req: ConfigUpdateRequest, x_agent_key: str = Header(None)):
    verify_key(x_agent_key)
    updates = req.dict(exclude_unset=True, exclude_none=True)
    if not updates:
        raise HTTPException(400, 'No fields to update')

    # Validate
    if 'provider' in updates and updates['provider'] not in PROVIDERS:
        raise HTTPException(400, f'Unknown provider: {updates["provider"]}')
    if 'temperature' in updates and not (0 <= updates['temperature'] <= 2):
        raise HTTPException(400, 'temperature must be 0-2')
    if 'max_tokens' in updates and not (50 <= updates['max_tokens'] <= 8000):
        raise HTTPException(400, 'max_tokens must be 50-8000')
    if 'quality_gate_threshold' in updates and not (1 <= updates['quality_gate_threshold'] <= 10):
        raise HTTPException(400, 'quality_gate_threshold must be 1-10')

    # Reject api_key that looks corrupted (whitespace, non-ASCII, error-like text).
    if 'api_key' in updates:
        k = (updates['api_key'] or '').strip()
        if not k:
            raise HTTPException(400, 'api_key cannot be empty')
        if len(k) < 10 or len(k) > 200:
            raise HTTPException(400, 'api_key length must be 10-200 chars')
        if any(c.isspace() for c in k):
            raise HTTPException(400, 'api_key must not contain whitespace')
        if not all(0x20 <= ord(c) <= 0x7e for c in k):
            raise HTTPException(400, 'api_key must be ASCII printable only (no Vietnamese / non-Latin chars)')
        lower = k.lower()
        for bad in ('error', 'failed', 'invalid', 'thất bại', 'unauthorized'):
            if bad in lower:
                raise HTTPException(400, f'api_key looks like an error message (contains "{bad}")')
        if any(c in k for c in '{}[]'):
            raise HTTPException(400, 'api_key looks like JSON object, not a key')
        updates['api_key'] = k

    if 'wp_app_password' in updates:
        wp_pass = updates['wp_app_password']
        if wp_pass and is_masked(wp_pass):
            updates.pop('wp_app_password')
        elif wp_pass is not None:
            updates['wp_app_password'] = wp_pass.strip()
    if 'wp_token' in updates:
        tok = updates['wp_token']
        if tok and is_masked(tok):
            updates.pop('wp_token')
        elif tok is not None:
            updates['wp_token'] = tok.strip()
    if 'gsc_credentials_json' in updates:
        gsc_cred = updates['gsc_credentials_json']
        if gsc_cred and is_masked(gsc_cred):
            updates.pop('gsc_credentials_json')
        elif gsc_cred is not None:
            updates['gsc_credentials_json'] = gsc_cred.strip()
    if 'ga4_credentials_json' in updates:
        ga4_cred = updates['ga4_credentials_json']
        if ga4_cred and is_masked(ga4_cred):
            updates.pop('ga4_credentials_json')
        elif ga4_cred is not None:
            updates['ga4_credentials_json'] = ga4_cred.strip()
    if 'wp_sites' in updates:
        sites = updates['wp_sites']
        if isinstance(sites, list):
            cleaned = []
            for s in sites:
                if isinstance(s, dict) and s.get('url'):
                    # Don't overwrite token if it's masked
                    if s.get('token') and is_masked(s['token']):
                        # Keep existing token from DB
                        pass  # will be merged below
                    else:
                        cleaned.append(s)
            if cleaned:
                updates['wp_sites'] = cleaned
            else:
                updates.pop('wp_sites', None)

    pool = await get_pool()
    try:
        # Merge with existing
        row = await pool.fetchrow('SELECT config FROM hermes_config WHERE id = 1')
        existing = dict(row['config']) if row else {}

        if 'fallback_keys' in updates:
            existing_keys = existing.get('fallback_keys') or {}
            if not isinstance(existing_keys, dict):
                existing_keys = {}
            new_keys = updates['fallback_keys'] or {}
            for env_var, api_value in new_keys.items():
                if api_value == "":
                    existing_keys[env_var] = ""
                elif api_value and not is_masked(api_value):
                    # Basic validation similar to the primary api_key
                    val = api_value.strip()
                    if len(val) >= 10 and not any(c.isspace() for c in val):
                        existing_keys[env_var] = val
            updates['fallback_keys'] = existing_keys

        if 'fallback_chain' in updates:
            chain_list = updates['fallback_chain']
            if isinstance(chain_list, list):
                updates['fallback_chain'] = [p.dict() if hasattr(p, 'dict') else p for p in chain_list]

        merged = {**existing, **updates}

        # Sync primary api_key if provider changed
        if 'provider' in updates:
            pconfig = PROVIDER_CONFIG.get(updates['provider'])
            if pconfig:
                env_var = pconfig["api_key_env"]
                fb_keys = merged.get('fallback_keys') or {}
                if env_var in fb_keys and fb_keys[env_var]:
                    merged['api_key'] = fb_keys[env_var]

        await pool.execute(
            'UPDATE hermes_config SET config = $1, updated_at = now() WHERE id = 1',
            merged,
        )
        # Invalidate cache
        global _config_cache_ts
        _config_cache_ts = 0
    except Exception as e:
        raise HTTPException(500, f'Save failed: {e}')
    return {'ok': True, 'updated_keys': list(updates.keys())}

class ConfigTestRequest(BaseModel):
    provider: str
    model: str
    api_key: str
    base_url: Optional[str] = None

@app.post('/config/test')
async def test_config(req: ConfigTestRequest, x_agent_key: str = Header(None)):
    verify_key(x_agent_key)
    t0 = time.time()
    try:
        api_key = req.api_key
        if api_key and is_masked(api_key):
            cfg = await load_config()
            if cfg.get('provider') == req.provider and mask_api_key(cfg.get('api_key') or '') == api_key:
                api_key = cfg.get('api_key') or ''
            else:
                pconfig = PROVIDER_CONFIG.get(req.provider)
                if pconfig:
                    env_var = pconfig["api_key_env"]
                    db_val = (cfg.get('fallback_keys') or {}).get(env_var)
                    if db_val and mask_api_key(db_val) == api_key:
                        api_key = db_val
                    else:
                        api_key = db_val or ""
        
        base_url = req.base_url or PROVIDERS.get(req.provider, {}).get('base_url')
        test_cfg = {
            'provider': req.provider,
            'model': req.model,
            'api_key': api_key,
            'base_url': base_url,
            # Pin model directly so _resolve_model doesn't fall back to TIER_DEFAULTS
            'skill_models': {'generic': req.model},
        }
        # Simple ping
        text = llm_call('You are a test bot.', 'Reply with exactly: OK', 10, 0.0, test_cfg)
        latency_ms = int((time.time() - t0) * 1000)
        return {
            'ok': True,
            'provider': req.provider,
            'model': req.model,
            'latency_ms': latency_ms,
            'response_preview': text[:100],
        }
    except HTTPException as e:
        return {'ok': False, 'error': e.detail, 'latency_ms': int((time.time() - t0) * 1000)}
    except Exception as e:
        return {'ok': False, 'error': str(e), 'latency_ms': int((time.time() - t0) * 1000)}

# ── Campaign Review (Hermes recommends adjustments) ──────
class CampaignReviewRequest(BaseModel):
    campaign_id: str
    goal: Optional[str] = None
    current_stats: Optional[Dict[str, Any]] = None
    nick_stats: Optional[List[Dict[str, Any]]] = None

@app.post('/campaign-review')
async def campaign_review(req: CampaignReviewRequest, x_agent_key: str = Header(None)):
    """Hermes analyzes campaign performance + suggests adjustments per nick."""
    verify_key(x_agent_key)

    # Fetch full context
    ctx = await fetch_campaign_context(req.campaign_id)
    if not ctx:
        raise HTTPException(404, 'Campaign not found')

    goal = req.goal or ctx.get('goal') or ''
    if not goal:
        raise HTTPException(400, 'Campaign has no goal — set one first')

    stats_block = ''
    if req.current_stats:
        stats_block = f"\n## Tổng thể chiến dịch:\n{json.dumps(req.current_stats, ensure_ascii=False, indent=2)[:1500]}"

    nicks_block = ''
    if req.nick_stats and len(req.nick_stats) > 0:
        nicks_block = '\n## Hiệu suất từng nick:\n'
        for n in req.nick_stats[:20]:
            nicks_block += f"- {n.get('username', n.get('account_id', '?'))}: "
            nicks_block += f"role={n.get('role', '?')}, status={n.get('status', '?')}, "
            nicks_block += f"jobs={n.get('jobs_today', 0)}, fail={n.get('failed', 0)}, "
            nicks_block += f"score={n.get('avg_score', '?')}\n"

    system = f"""Bạn là Campaign Strategist AI cho hệ thống automation Facebook.
Nhiệm vụ: phân tích hiệu suất chiến dịch và đề xuất điều chỉnh cụ thể cho từng nick.

QUAN TRỌNG:
- Đề xuất phải SPECIFIC và ACTIONABLE (không chung chung)
- Mỗi action phải đi kèm lý do dựa trên data
- Ưu tiên: nick checkpoint cần xử lý → nick đang tốt cần scale → nick yếu cần boost
- Không đề xuất pause toàn bộ trừ khi data cho thấy rủi ro nghiêm trọng

Trả về JSON:
{{
  "summary": "1-2 câu tóm tắt tình hình",
  "recommendations": [
    {{
      "account_id": "uuid",
      "action": "increase|decrease|pause|focus|fix_checkpoint",
      "task_type": "campaign_nurture|discover_groups|comment_post|...",
      "reason": "lý do cụ thể dựa trên data",
      "priority": "high|medium|low"
    }}
  ]
}}"""

    user_prompt = f"""## Mục tiêu chiến dịch:
{goal}
{stats_block}
{nicks_block}

Hãy phân tích và đề xuất 3-5 actions cụ thể."""

    # Use ai_call with high context
    t0 = time.time()
    try:
        # Don't use ai_call here because we want a different system prompt
        text = llm_call(system, user_prompt, 1500, 0.3, await load_config(), 'orchestrator')
        latency_ms = int((time.time() - t0) * 1000)
        await record_call('campaign_review', user_prompt, text, latency_ms, True)

        # Parse JSON
        try:
            cleaned = text.strip()
            # Strip ```json fences if present
            if cleaned.startswith('```'):
                cleaned = cleaned.split('```', 2)
                cleaned = cleaned[1] if len(cleaned) > 1 else cleaned[0]
                if cleaned.startswith('json\n'):
                    cleaned = cleaned[5:]
                cleaned = cleaned.split('```')[0]
            start = cleaned.index('{')
            end = cleaned.rindex('}') + 1
            parsed = json.loads(cleaned[start:end])
        except Exception as parse_err:
            logger.warning('campaign_review parse failed: %s', parse_err)
            parsed = {
                'summary': 'Hermes phản hồi không phải JSON hợp lệ',
                'recommendations': [],
                'raw_response': text[:500],
            }

        # Persist to campaign_hermes_reviews
        try:
            pool = await get_pool()
            await pool.execute(
                """INSERT INTO campaign_hermes_reviews
                   (campaign_id, summary, recommendations, current_stats)
                   VALUES ($1::uuid, $2, $3, $4)""",
                req.campaign_id,
                parsed.get('summary', '')[:1000],
                parsed.get('recommendations', []),
                req.current_stats or {},
            )
        except Exception as save_err:
            logger.warning('save review failed: %s', save_err)

        return {
            'ok': True,
            'summary': parsed.get('summary', ''),
            'recommendations': parsed.get('recommendations', []),
            'latency_ms': latency_ms,
        }
    except Exception as e:
        logger.error('campaign_review failed: %s', e)
        raise HTTPException(502, f'Hermes review failed: {e}')

# ── Memory delete ─────────────────────────────────────────
@app.delete('/memory')
async def delete_memory(account_id: Optional[str] = None, all: bool = False,
                        x_agent_key: str = Header(None)):
    """Delete pilot memories. Query params:
       ?account_id=X → delete memories for one nick
       ?all=true → delete ALL memories (destructive!)"""
    verify_key(x_agent_key)
    if not account_id and not all:
        raise HTTPException(400, 'Provide account_id or all=true')

    pool = await get_pool()
    try:
        if all:
            result = await pool.execute('DELETE FROM ai_pilot_memory')
        else:
            # Validate uuid
            import re
            if not re.match(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', account_id, re.I):
                raise HTTPException(400, 'Invalid account_id UUID')
            result = await pool.execute(
                'DELETE FROM ai_pilot_memory WHERE account_id = $1::uuid', account_id)
        # asyncpg returns "DELETE <count>"
        count = int(result.split()[-1]) if result else 0
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f'Delete failed: {e}')
    return {'ok': True, 'deleted_rows': count}

def get_wp_client(config, site_idx: int = 0) -> WordPressClient:
    # Multi-site support: check wp_sites array first
    wp_sites = config.get("wp_sites") or []
    if wp_sites and isinstance(wp_sites, list):
        if site_idx < 0 or site_idx >= len(wp_sites):
            raise HTTPException(400, f"Site index {site_idx} out of range (have {len(wp_sites)} sites)")
        site = wp_sites[site_idx]
        url = site.get("url", "")
        token = site.get("token", "")
        if not url:
            raise HTTPException(400, f"WordPress site #{site_idx} has no URL configured")
        if not token:
            raise HTTPException(400, f"WordPress site #{site_idx} has no token configured")
        return WordPressClient(wp_url=url, token=token)
    # Fallback to legacy single-site config
    wp_url = config.get("wp_url", "")
    wp_token = config.get("wp_token", "")
    wp_username = config.get("wp_username", "")
    wp_app_password = config.get("wp_app_password", "")
    if not wp_url:
        raise HTTPException(400, "WordPress Site URL is missing. Go to WP Audit settings to configure.")
    if wp_token:
        return WordPressClient(wp_url=wp_url, token=wp_token)
    if wp_username and wp_app_password:
        return WordPressClient(wp_url=wp_url, username=wp_username, app_password=wp_app_password)
    raise HTTPException(400, "WordPress credentials missing. Enter Site URL + Token in WP Audit settings.")

# ── WORDPRESS INTEGRATION & AUDIT ───────────────────────────────────────────

TOPIC_ENTITY_MAP = {
    "ai-agent": {
        "topic_label": "AI Agent",
        "expected_entities": [
            "AutoGPT", "AgentGPT", "CrewAI", "LangChain", "LangGraph",
            "BabyAGI", "Claude Computer Use", "Devin", "SWE-agent",
            "OpenAI Assistants API", "Microsoft Copilot", "Cursor AI",
            "n8n", "Zapier AI", "Make (Integromat)", "Perplexity",
            "Google Gemini Agents", "Amazon Bedrock Agents",
        ],
        "expected_lsi": [
            "autonomous agent", "multi-agent system", "tool use",
            "function calling", "chain of thought", "ReAct framework",
            "agentic workflow", "tác nhân AI", "tự động hóa",
            "memory", "planning", "task decomposition",
            "RAG", "long-term memory", "short-term memory",
        ],
        "pillar_or_cluster": "pillar",
        "min_word_count": 2000,
    },
    "chatgpt-canva": {
        "topic_label": "Chỉnh sửa ảnh ChatGPT trên Canva",
        "expected_entities": [
            "DALL-E 3", "GPT-4o", "Canva Pro", "Canva Free",
            "ChatGPT Plus", "Adobe Express", "Adobe Firefly",
            "Figma", "Midjourney", "Stable Diffusion",
            "Remove.bg", "Clipchamp",
        ],
        "expected_lsi": [
            "chèn chữ", "thêm logo", "resize ảnh", "tải ảnh về",
            "export PNG", "export JPG", "template Canva",
            "tách nền", "background removal", "chỉnh màu",
            "font chữ", "bố cục", "layer", "social media post",
            "banner", "poster", "kích thước ảnh",
            "ảnh AI", "tạo ảnh AI", "chỉnh sửa AI",
        ],
        "pillar_or_cluster": "cluster",
        "min_word_count": 1000,
        "post_intent": "how_to",
    },
    "chinh-sua-anh": {
        "topic_label": "Chỉnh sửa ảnh AI",
        "expected_entities": [
            "Canva", "Adobe Express", "Figma", "GIMP",
            "Photoshop", "ChatGPT", "Gemini", "Midjourney",
            "Remove.bg", "Clipdrop",
        ],
        "expected_lsi": [
            "chỉnh sửa ảnh online", "chỉnh sửa ảnh miễn phí",
            "tách nền ảnh", "thêm chữ vào ảnh", "resize ảnh",
            "công cụ thiết kế", "ảnh AI", "tạo ảnh AI",
        ],
        "pillar_or_cluster": "cluster",
        "min_word_count": 800,
        "post_intent": "how_to",
    },
}

def normalize(text):
    if not text:
        return ""
    import unicodedata
    import re
    text = text.lower()
    text = unicodedata.normalize("NFD", text)
    text = "".join(c for c in text if unicodedata.category(c) != "Mn")
    text = re.sub(r'[^a-z0-9\s]', ' ', text)
    return " ".join(text.split())

def detect_topic_entities(slug: str, title: str = "") -> dict:
    slug_lower = (slug or "").lower()
    title_lower = (title or "").lower()

    # Thử match nhiều từ trong slug hoặc title, không chỉ full key
    for key, data in TOPIC_ENTITY_MAP.items():
        key_parts = key.split("-")
        # Match nếu ≥60% các phần của key xuất hiện trong slug hoặc title
        matches = sum(1 for p in key_parts if p in slug_lower or p in title_lower)
        if len(key_parts) > 0 and (matches / len(key_parts)) >= 0.6:
            return data
    return {}

def detect_post_intent(slug: str, headings: list) -> str:
    """
    Phân loại intent bài viết để áp đúng GEO criteria.
    """
    how_to_signals = ["cach", "huong-dan", "bat-mi", "meo", "thu-thuat", "lam-the-nao"]
    what_is_signals = ["la-gi", "khai-niem", "dinh-nghia", "tim-hieu"]
    compare_signals = ["so-sanh", "vs", "hay", "tot-nhat", "tot-hon"]

    slug_lower = (slug or "").lower()
    if any(s in slug_lower for s in how_to_signals):
        return "how_to"
    if any(s in slug_lower for s in what_is_signals):
        return "what_is"
    if any(s in slug_lower for s in compare_signals):
        return "comparison"
    
    # Fallback: đọc H2
    h2_texts = [h.get("text", "").lower() for h in headings if h.get("level") == "h2"]
    h2_text = " ".join(h2_texts)
    if "bước" in h2_text or "hướng dẫn" in h2_text or "cách" in h2_text:
        return "how_to"
    return "general"

def generate_auto_faq(post_intent: str, main_keyword: str, existing_faq_count: int) -> list:
    """Tạo FAQ bổ sung dựa vào intent và keyword."""
    needed = 5 - existing_faq_count
    if needed <= 0:
        return []
    
    kw = main_keyword or "chủ đề này"
    
    # Làm sạch keyword nếu nó là dạng raw slug không dấu
    if kw:
        is_raw_ascii = all(c.isspace() or c.isdigit() or (97 <= ord(c.lower()) <= 122) or c in '-_' for c in kw)
        if is_raw_ascii:
            slug_normalized = kw.lower().replace(" ", "-").replace("_", "-")
            matched_label = None
            # Thử match flexible với TOPIC_ENTITY_MAP
            for key, data in TOPIC_ENTITY_MAP.items():
                key_parts = key.split("-")
                matches = sum(1 for p in key_parts if p in slug_normalized)
                if len(key_parts) > 0 and (matches / len(key_parts)) >= 0.6:
                    matched_label = data.get("topic_label")
                    break
            if matched_label:
                kw = matched_label
            else:
                kw = kw.replace("-", " ").replace("_", " ").title()

    templates = [
        {
            "q": f"Có thể thực hiện {kw} trên điện thoại không?",
            "a": f"Có thể. Hầu hết các ứng dụng và công cụ hỗ trợ {kw} đều có phiên bản dành cho di động hoặc giao diện responsive giúp bạn thao tác dễ dàng."
        },
        {
            "q": f"Việc {kw} có mất phí bản quyền không?",
            "a": f"Các công cụ hỗ trợ {kw} thường có gói miễn phí cơ bản. Nếu muốn nâng cấp hoặc dùng tính năng chuyên sâu hơn, bạn có thể đăng ký gói trả phí."
        },
        {
            "q": f"Lưu ý quan trọng nhất khi tiến hành {kw} là gì?",
            "a": f"Lưu ý quan trọng nhất là bạn cần tuân thủ đúng quy trình kỹ thuật, đảm bảo độ nét và bố cục nội dung hài hòa để đạt hiệu quả tối ưu nhất."
        },
        {
            "q": f"Có hướng dẫn tự học {kw} miễn phí không?",
            "a": f"Có rất nhiều tài liệu tự học {kw} miễn phí trên internet, bao gồm các bài viết hướng dẫn chi tiết và video trên YouTube để bạn làm theo."
        },
        {
            "q": f"Yêu cầu cấu hình máy tính thế nào để làm {kw}?",
            "a": f"Phần lớn các công cụ hiện nay chạy trực tiếp trên trình duyệt web nên chỉ cần máy tính có kết nối mạng ổn định là bạn có thể thực hiện được."
        }
    ]
    
    return templates[:needed]

AUDIT_SYSTEM_PROMPT = """
Bạn là chuyên gia audit SEO/GEO nội dung tiếng Việt. Nhiệm vụ duy nhất: đọc bài viết được cung cấp, chạy audit theo 4 tiêu chí, trả về JSON.

---

## KIẾN THỨC NỀN

### GEO (Generative Engine Optimization)
GEO là tối ưu để AI (ChatGPT, Perplexity, Google AI Overview) trích dẫn bài viết khi trả lời người dùng.
Năm 2026, ~40% search query có AI Overview box. Bài không tối ưu GEO mất visibility dù rank #1.

GEO tốt cần:
- DIRECT ANSWER: Đối với bài general/what_is, 200 từ đầu phải có câu định nghĩa dạng "[Chủ đề] là [mô tả ngắn gọn]". AI đọc đoạn đầu trước — nếu không thấy định nghĩa rõ, bỏ qua bài. Đối với bài how_to, 200 từ đầu nêu rõ mục tiêu bài viết sẽ hướng dẫn làm gì.
- DEFINITION CLARITY: Cắt 3 câu đầu ra đọc độc lập — nếu vẫn trả lời được "X là gì?" (hoặc bài hướng dẫn về cái gì) thì đạt. Không dùng đại từ mơ hồ "nó", "điều này", "các loại trên".
- FAQ BLOCK: ≥5 cặp Q&A cuối bài. Câu hỏi dạng người thực hỏi ("Nên dùng X hay Y?", "X mất phí không?"), câu trả lời tự đứng độc lập được (2–4 câu).
- STRUCTURED CONTENT: Bảng so sánh > Numbered list > Bullet list > Prose. Bài so sánh/Top X bắt buộc có bảng so sánh. Bài how_to bắt buộc có danh sách các bước đánh số.
- ENTITY + SỐ LIỆU: Entity phải có context đi kèm ("Groq (LPU đạt 280 token/giây)" thay vì "Groq là AI"). Có số liệu cụ thể: %, $, năm, số lượng.
- FRESHNESS: Có năm hiện tại (2025/2026) trong title/H1/content.

### GEO scoring & checklist mapping theo Post Intent:
Dựa trên giá trị `Post Intent` được cung cấp trong prompt, hãy tính điểm và điền các checklist keys của GEO ("checklist.geo") theo quy tắc sau:

1. Nếu Post Intent = "how_to":
   - "opening_definition": Đạt (True) nếu 200 từ đầu nêu rõ bài sẽ hướng dẫn làm gì (KHÔNG yêu cầu định nghĩa lý thuyết "X là gì", không trừ điểm vì thiếu định nghĩa).
   - "definition_independent": Đạt (True) nếu phần mục tiêu hướng dẫn ở mở bài đọc độc lập dễ hiểu, không dùng đại từ mơ hồ.
   - "step_by_step": Đạt (True) nếu bài có các bước/step hướng dẫn được đánh số rõ ràng (Numbered list).
   - "entity_context": Đạt (True) nếu bài có mục "Chuẩn bị" / "Yêu cầu trước" trước khi bắt đầu hướng dẫn.
   - "comparison_table": Đạt (True) nếu bài có mục "Lỗi thường gặp" hoặc "Mẹo thêm" ở cuối bài.
   - Các key khác tính điểm bình thường theo nội dung bài.

2. Nếu Post Intent = "comparison":
   - "comparison_table": Đạt (True) nếu bài có bảng so sánh trực quan (bắt buộc).
   - "definition_independent": Tự động Đạt (True) nếu bài có verdict/kết luận rõ ràng dạng "Nên chọn X nếu..., nên chọn Y nếu...".
   - "opening_definition": Đạt (True) nếu bài có câu nêu rõ các đối tượng so sánh ở phần mở đầu (KHÔNG yêu cầu định nghĩa lý thuyết đầu bài).

3. Nếu Post Intent = "what_is" hoặc "general":
   - Áp dụng các quy tắc GEO truyền thống (cần câu định nghĩa "[X] là..." ở mở bài).

### SEO Fundamentals
- META TITLE: 50–60 ký tự (đếm ký tự, không phải từ). Phải chứa main keyword.
  * QUY TẮC CHECK KEYWORD: Tìm kiếm TỪNG TỪ riêng lẻ của main_keyword trong title/H1 (không phân biệt dấu hay không dấu), không bắt buộc phải xuất hiện liền nhau theo thứ tự (không yêu cầu exact phrase match). Nếu ≥70% số từ đơn lẻ của main_keyword xuất hiện trong title/H1 → được tính là "có keyword". Tuyệt đối KHÔNG được báo lỗi "không có keyword" khi title chứa đủ các từ khóa chính.
- META DESCRIPTION: Bắt buộc dài từ 140–160 ký tự. Phải chứa main keyword. Có call-to-action cuối câu. Nếu bản thảo nháp ngắn hơn 130 ký tự, hãy bắt buộc kéo dài bằng cách bổ sung thêm lợi ích cụ thể hoặc câu kêu gọi hành động (CTA) cho đến khi đạt độ dài tối ưu (đạt từ 140–160 ký tự).
- H1: đúng 1 cái. Phải chứa main keyword (áp dụng cùng quy tắc check keyword ≥70% ở trên).
- H2: ≥3 cái. Mỗi H2 là 1 chủ đề lớn. Có keyword variant.
  * HỆ THỐNG QUY TẮC DUYỆT H2 (HEADING AUDIT):
    - Đối với bài "how_to" cluster: Cấm đề xuất các H2 mang tính giới thiệu, lý thuyết chung chung (như "Giới thiệu về ChatGPT và Canva", "ChatGPT là gì", "Tổng quan về Canva"). Bắt buộc đề xuất thay thế bằng các H2 thực tiễn hơn như "Yêu cầu chuẩn bị trước khi bắt đầu" hoặc dạng câu hỏi truy vấn người dùng (ví dụ: "ChatGPT có kết nối với Canva được không?" để tạo GEO signal).
    - Đối với tất cả các bài: Cấm đề xuất H2 kết luận sáo rỗng hoặc quá ngắn (như "Kết luận", "Tổng kết"). Bắt buộc đề xuất thay thế bằng H2 thực tiễn chứa keyword và GEO signal, ví dụ: "Khi nào nên dùng ChatGPT kết hợp Canva?".
- WORD COUNT: Pillar/Top-X ≥1.500 từ. Cluster ≥800 từ. <500 từ = thin content nghiêm trọng.
- KEYWORD DENSITY: 0.5%–2%. Dưới 0.3% = thiếu. Trên 3% = nhồi nhét.
- INTERNAL LINKS: Pillar ≥5 links ra cluster. Cluster ≥1 link về pillar.
- ANCHOR TEXT: Phải chứa keyword liên quan. Tuyệt đối không dùng "xem thêm", "click here", "bài này".

### Semantic SEO
Không phải về keyword density. Về việc bao phủ đầy đủ semantic field của topic.
- LSI KEYWORDS: Từ/cụm từ Google kỳ vọng thấy trong bài về topic này. Bài thiếu LSI = thiếu depth.
- ENTITY COVERAGE: Tên cụ thể (người, công ty, sản phẩm, công nghệ) phải xuất hiện đủ. Thiếu entity core = thin content.
- TOPIC COMPLETENESS: Cover đủ search intent — informational (X là gì) + commercial (X tốt không, so sánh).
- CANNIBALIZATION: 2 bài cùng site target cùng keyword → Google không biết rank bài nào.

### Pillar / Topic Cluster
- PILLAR: Bao quát topic lớn. Link ra nhiều cluster. Word count ≥2.000 từ. Mỗi H2 là 1 subtopic.
- CLUSTER: Deep-dive 1 subtopic. Luôn link về pillar. Không target keyword giống pillar.
- PHÂN BIỆT: Keyword broad + người muốn overview → Pillar. Keyword long-tail + người muốn chi tiết → Cluster.
- CLUSTER GAP: Mỗi H2 quan trọng trong pillar đáng lẽ phải có 1 bài cluster riêng. H2 nào chưa có cluster = gap.
- ORPHAN: Cluster tồn tại nhưng pillar chưa link về = orphan page, mất link equity.

### Thị trường Việt Nam
- FAQ phải dùng đúng cách người VN hỏi: "X có tốt không?", "X hay Y cái nào tốt hơn?", "Dùng X có an toàn không?"
- Keyword có dấu và không dấu đều có volume — dùng tự nhiên cả hai trong content.
- Author bio + ngày cập nhật rõ ràng quan trọng cho EEAT thị trường VN.

---

## SCORING RUBRIC (tính điểm chính xác, không ước lượng)

### SEO (25 điểm)
Bắt đầu từ 0, cộng điểm theo checklist dưới:
+2  Meta title có main keyword
+2  Meta title ≤60 ký tự                    [-4 nếu >70 ký tự]
+1  Meta title 50–60 ký tự (zone tối ưu)
+2  Meta description có main keyword
+1  Meta description ≤160 ký tự
+1  Meta description có call-to-action
+2  Đúng 1 thẻ H1                           [-3 nếu H1=0 hoặc >1]
+2  H1 có main keyword
+2  Có ≥3 thẻ H2
+1  Có ≥5 thẻ H2
+2  Word count ≥1.500 từ (pillar) / ≥800 từ (cluster)
+1  Word count ≥2.500 từ (pillar) / ≥1.200 từ (cluster)
+2  ≥5 internal links có anchor text chứa keyword
+1  ≥10 internal links
+1  Keyword xuất hiện trong 100 từ đầu
+2  Ảnh có alt text (nếu có ảnh: >50%=+1, 100%=+2)

### GEO (25 điểm)
Bắt đầu từ 0:
+5  200 từ đầu có câu định nghĩa rõ ràng dạng "[X] là..."
+3  Định nghĩa có thể đọc độc lập, không dùng đại từ tham chiếu
+4  Có FAQ block ≥5 cặp Q&A
+2  FAQ nằm cuối bài (đúng vị trí)
+2  Câu hỏi FAQ dạng người thực hỏi, không phải học thuật
+3  Có bảng so sánh (table)
+2  Có numbered list hoặc step-by-step
+2  Entity có số liệu/context cụ thể đi kèm (không chỉ mention tên)
+1  Có số liệu thống kê cụ thể (%, $, năm, số lượng)
+1  Có năm hiện tại (2025/2026) trong title hoặc content

### Pillar/Cluster (25 điểm)
Bắt đầu từ 0:
+5  Xác định đúng loại bài (pillar/cluster) và nội dung phù hợp loại đó
+4  Internal link đúng chiều (pillar→cluster hoặc cluster→pillar)
+3  Số lượng internal link đủ theo loại bài
+3  Anchor text của internal link có keyword liên quan
+5  Topic coverage đủ: pillar cover ≥70% subtopic chính / cluster focus đúng 1 subtopic
+3  Không có cluster gap nghiêm trọng (H2 quan trọng đều có cluster)
+2  Không phải orphan page (có ít nhất 1 link từ pillar về nếu là cluster)

### Semantic (25 điểm)
Bắt đầu từ 0:
+3  Main keyword trong H1
+3  Main keyword trong 100 từ đầu
+2  Keyword density 0.5%–2%                 [-3 nếu <0.3% hoặc >3%]
+5  Entity coverage: đủ các entity core bắt buộc của topic
+3  Entity coverage: có thêm secondary entities
+3  LSI keywords đa dạng, xuất hiện tự nhiên
+3  Topic completeness: cover cả intent informational lẫn commercial
+3  Không có dấu hiệu keyword cannibalization

---

## QUY TẮC OUTPUT BẮT BUỘC

1. Chỉ trả về JSON. Không markdown, không giải thích, không text bên ngoài JSON.
2. audit_score = seo + geo + pillar_cluster + semantic. Tính lại trước khi ghi.
3. Suggestions phải CỤ THỂ từ content thực. Không được dùng câu chung chung như "thêm từ liên quan" mà không liệt kê từ cụ thể.
4. Meta title/description đề xuất: ghi kèm "(XX ký tự)" sau chuỗi. Nếu >60 ký tự cho title → viết lại, không được phép submit title >60 ký tự. Meta description đề xuất bắt buộc phải nằm trong khoảng 140–160 ký tự; nếu bản thảo nháp <130 ký tự, hãy bắt buộc kéo dài bằng cách bổ sung thêm lợi ích cụ thể hoặc câu kêu gọi hành động (CTA) cho đến khi đạt độ dài tối ưu.
5. missing_entities: tên cụ thể (OpenRouter, Together.ai), không phải "các nền tảng AI".
6. Severity: "critical" chỉ dùng khi lỗi gây mất rank nghiêm trọng (H1=0, thin content <500 từ, không có main keyword). Lỗi thông thường dùng "high"/"medium"/"low".
7. Bắt buộc thực hiện BƯỚC 1 - TRÍCH XUẤT và ghi đầy đủ thông tin vào trường "extraction" ở gốc JSON trước khi thực hiện bước 2 audit.
"""

AUDIT_USER_PROMPT = """
## DỮ LIỆU BÀI VIẾT

URL: {url}
Slug: {slug}
Loại bài (từ pillar map): {post_type_hint}
Pillar topic: {pillar_topic_hint}
Post Intent: {post_intent}

## METRICS ĐÃ ĐO (dùng để tính điểm — không ước lượng lại)
- Word count: {word_count} từ
- H1 count: {h1_count}
- H2 count: {h2_count}
- H3 count: {h3_count}
- Internal links: {internal_link_count}
- External links: {external_link_count}
- Image count: {image_count} ({images_without_alt} ảnh thiếu alt)
- Meta title: "{meta_title}" ({meta_title_len} ký tự)
- Meta description: "{meta_desc}" ({meta_desc_len} ký tự)
- Keyword ước đoán từ slug: "{main_keyword_guess}"
- Keyword density: {keyword_density}%
- Keyword xuất hiện: {keyword_occurrences} lần

## 200 TỪ ĐẦU BÀI (kiểm tra GEO direct answer)
{content_preview_200w}

## CẤU TRÚC HEADING
{headings_text}

## INTERNAL LINKS ({internal_link_count} links)
{internal_links_text}

## EXPECTED ENTITIES cho topic này (so sánh với content)
{expected_entities}

## EXPECTED LSI KEYWORDS cho topic này
{expected_lsi}

## NỘI DUNG ĐẦY ĐỦ
{content}

## PILLAR MAP CỦA SITE
{pillar_context}

## CÁC BÀI VIẾT KHÁC ĐANG CÓ TRÊN SITE ĐỂ LIÊN KẾT
{recent_posts_context}

---

BƯỚC 1 — TRÍCH XUẤT (làm trước, không skip):
Đọc toàn bộ content, sau đó trích xuất các thông tin dưới đây và đặt vào trường "extraction" trong JSON output:
a) Tên các AI Agent cụ thể được đề cập trong bài (tên thật, không paraphrase)
b) Câu đầu tiên của bài (copy nguyên văn)
c) Có bảng so sánh không? Nếu có, liệt kê các cột?
d) Có FAQ block không? Bao nhiêu câu hỏi?
e) Các internal link hiện có (anchor text + URL)

BƯỚC 2 — AUDIT dựa trên kết quả trích xuất ở bước 1:
Thực hiện audit theo đúng scoring rubric trong system prompt.
Tính điểm từng mục trước, rồi mới ghi vào JSON.
Dựa vào content THỰC TẾ ở trên để viết suggestions — không dùng câu template.

Trả về JSON với structure sau:

{{
  "extraction": {{
    "ai_agents_mentioned": ["AutoGPT", "CrewAI", "etc."],
    "first_sentence": "copy nguyên văn câu đầu tiên",
    "has_comparison_table": true,
    "comparison_table_columns": ["Cột 1", "Cột 2"],
    "faq_count": 0,
    "existing_internal_links": [{{"anchor": "anchor text", "url": "https://url"}}]
  }},
  "checklist": {{
    "seo": {{
      "meta_title_has_keyword": true,
      "meta_title_len_60": true,
      "meta_title_len_opt": false,
      "meta_desc_has_keyword": true,
      "meta_desc_len_160": true,
      "meta_desc_has_cta": false,
      "h1_exactly_one": true,
      "h1_has_keyword": true,
      "h2_count_3": true,
      "h2_count_5": false,
      "word_count_min": true,
      "word_count_opt": false,
      "internal_links_keyword": true,
      "internal_links_count": false,
      "keyword_in_opening": true,
      "images_have_alt": true
    }},
    "geo": {{
      "opening_definition": true,
      "definition_independent": true,
      "has_faq_5": true,
      "faq_at_end": true,
      "faq_user_style": true,
      "comparison_table": false,
      "step_by_step": true,
      "entity_context": true,
      "statistics": false,
      "current_year": true
    }},
    "pillar_cluster": {{
      "correct_type": true,
      "correct_direction": true,
      "sufficient_links": true,
      "anchors_have_keyword": true,
      "topic_coverage": true,
      "no_cluster_gaps": false,
      "not_orphan": true
    }},
    "semantic": {{
      "keyword_h1": true,
      "keyword_opening": true,
      "secondary_entities": false,
      "lsi_natural": true,
      "intent_complete": true,
      "no_cannibalization": true,
      "depth_freshness": true
    }}
  }},
  "post_type": "pillar" | "cluster" | "standalone",
  "pillar_topic": "tên pillar",
  "main_keyword": "keyword chính thực sự của bài (không phải slug)",
  "audit_score": <tổng 4 category>,
  "score_breakdown": {{
    "seo": <0-25>,
    "geo": <0-25>,
    "pillar_cluster": <0-25>,
    "semantic": <0-25>
  }},
  "strengths": [
    "điểm mạnh cụ thể — có dẫn chứng từ content"
  ],
  "critical_issues": [
    {{
      "category": "SEO" | "GEO" | "Pillar/Cluster" | "Semantic",
      "severity": "critical" | "high" | "medium" | "low",
      "issue": "mô tả vấn đề — có số liệu cụ thể nếu được",
      "location": "meta_title" | "meta_desc" | "h1" | "h2" | "content" | "internal_links" | "faq" | "opening",
      "fix": "hướng dẫn fix CỤ THỂ — có ví dụ viết lại nếu là copy/text"
    }}
  ],
  "suggestions": {{
    "meta_title": "title mới (XX ký tự)",
    "meta_description": "desc mới (XXX ký tự)",
    "h1": "H1 mới nếu cần sửa",
    "opening_paragraph": "đoạn mở bài GEO-optimized: định nghĩa rõ + direct answer + entity + số liệu",
    "h2_structure": ["H2 1", "H2 2", "H2 3", "H2 4", "H2 5 — FAQ"],
    "faq_block": [
      {{"q": "câu hỏi dạng người VN thực hỏi", "a": "trả lời 2–4 câu tự đứng được"}}
    ],
    "internal_links_to_add": [
      {{"anchor": "anchor text có keyword", "target": "tên bài cần link đến", "url": "URL tuyệt đối của bài đó lấy từ Pillar Map của site"}}
    ],
    "missing_entities": ["Tên Entity 1", "Tên Entity 2"],
    "missing_lsi": ["lsi keyword 1", "lsi keyword 2"],
    "cluster_gaps": ["Tên bài cluster cần tạo để fill gap"]
  }},
  "geo_quick_wins": [
    "hành động cụ thể làm được ngay, có ví dụ thực từ bài"
  ]
}}
"""

async def get_expected_terms(title, slug, config) -> tuple:
    prompt = f"""Gợi ý danh sách expected entities (tên thương hiệu, công nghệ, công cụ, người, địa danh liên quan) và expected LSI keywords (từ khóa đồng nghĩa/liên quan mật thiết) cho chủ đề bài viết sau.
Tiêu đề: {title}
Slug: {slug}

Trả về dạng văn bản ngắn gọn:
Expected Entities: [danh sách cách nhau bằng dấu phẩy]
Expected LSI Keywords: [danh sách cách nhau bằng dấu phẩy]"""
    try:
        fallback_keys = config.get('fallback_keys') or {}
        res = call_with_fallback(
            messages=[{"role": "user", "content": prompt}],
            config=config,
            fallback_keys=fallback_keys,
            temperature=0.1,
            max_tokens=200,
        )
        entities = ""
        lsi = ""
        for line in res.split("\n"):
            if "entities" in line.lower():
                entities = line.split(":", 1)[-1].strip()
            elif "lsi" in line.lower():
                lsi = line.split(":", 1)[-1].strip()
        return entities or "N/A", lsi or "N/A"
    except Exception:
        return "N/A", "N/A"

SEO_CHECKLIST = {
    "meta_title_has_keyword": ("Meta title chứa main keyword", 2),
    "meta_title_len_60": ("Meta title ≤60 ký tự", 2),
    "meta_title_len_opt": ("Meta title 50–60 ký tự (zone tối ưu)", 1),
    "meta_desc_has_keyword": ("Meta description chứa main keyword", 2),
    "meta_desc_len_160": ("Meta description ≤160 ký tự", 1),
    "meta_desc_has_cta": ("Meta description có call-to-action", 1),
    "h1_exactly_one": ("Đúng 1 thẻ H1", 2),
    "h1_has_keyword": ("H1 chứa main keyword", 2),
    "h2_count_3": ("Có ≥3 thẻ H2", 2),
    "h2_count_5": ("Có ≥5 thẻ H2", 1),
    "word_count_min": ("Word count đạt chuẩn tối thiểu (1500w pillar / 800w cluster)", 2),
    "word_count_opt": ("Word count đạt chuẩn tối ưu (2500w pillar / 1200w cluster)", 1),
    "internal_links_keyword": ("≥5 internal links có anchor text chứa keyword", 2),
    "internal_links_count": ("≥10 internal links", 1),
    "keyword_in_opening": ("Keyword xuất hiện trong 100 từ đầu", 1),
    "images_have_alt": ("Tất cả ảnh có alt text", 2),
}

GEO_CHECKLIST = {
    "opening_definition": ("200 từ đầu có câu định nghĩa rõ ràng dạng [X] là...", 5),
    "definition_independent": ("Định nghĩa có thể đọc độc lập (không dùng đại từ)", 3),
    "has_faq_5": ("Có FAQ block ≥5 cặp Q&A", 4),
    "faq_at_end": ("FAQ nằm cuối bài (đúng vị trí)", 2),
    "faq_user_style": ("Câu hỏi FAQ dạng người thực hỏi", 2),
    "comparison_table": ("Có bảng so sánh (table)", 3),
    "step_by_step": ("Có numbered list hoặc step-by-step", 2),
    "entity_context": ("Entity có số liệu/context cụ thể đi kèm", 2),
    "statistics": ("Có số liệu thống kê cụ thể (%, $, năm, số lượng)", 1),
    "current_year": ("Có năm hiện tại (2025/2026) trong title hoặc content", 1),
}

PILLAR_CLUSTER_CHECKLIST = {
    "correct_type": ("Xác định đúng loại bài (pillar/cluster) và nội dung phù hợp", 5),
    "correct_direction": ("Internal link đúng chiều (pillar→cluster / cluster→pillar)", 4),
    "sufficient_links": ("Số lượng internal link đủ theo loại bài", 3),
    "anchors_have_keyword": ("Anchor text của internal link có keyword liên quan", 3),
    "topic_coverage": ("Topic coverage đủ (pillar ≥70% / cluster focus 1 subtopic)", 5),
    "no_cluster_gaps": ("Không có cluster gap nghiêm trọng", 3),
    "not_orphan": ("Không phải orphan page (có link từ pillar về cluster)", 2),
}

SEMANTIC_CHECKLIST = {
    "keyword_h1": ("Main keyword xuất hiện trong H1", 3),
    "keyword_opening": ("Main keyword xuất hiện trong 100 từ đầu", 3),
    "secondary_entities": ("Entity coverage: có thêm secondary entities", 3),
    "lsi_natural": ("LSI keywords đa dạng, xuất hiện tự nhiên", 3),
    "intent_complete": ("Cover cả intent informational lẫn commercial", 3),
    "no_cannibalization": ("Không có dấu hiệu keyword cannibalization", 3),
    "depth_freshness": ("Độ sâu kiến thức & độ tươi mới nội dung", 7),
}

async def run_audit_llm(
    title, slug, url, content, headings, internal_links,
    meta_title, meta_desc, excerpt, pillar_context, config,
    raw_html="", model_override: str = None,
    recent_posts_context: str = ""
) -> dict:
    from bs4 import BeautifulSoup
    import re
    import json

    # 1. Heading counts
    h1_count = len([h for h in headings if h.get("level") == "h1"])
    h2_count = len([h for h in headings if h.get("level") == "h2"])
    h3_count = len([h for h in headings if h.get("level") == "h3"])

    # 2. Image and alt counts from raw_html
    soup_html = BeautifulSoup(raw_html, "html.parser") if raw_html else BeautifulSoup("", "html.parser")
    images = soup_html.find_all("img")
    image_count = len(images)
    images_without_alt = len([img for img in images if not img.get("alt")])

    # 3. Link counts
    wp_url = config.get("wp_url", "")
    all_links = soup_html.find_all("a", href=True)
    internal_link_count = len(internal_links)
    external_links = []
    for a in all_links:
        href = a["href"]
        if wp_url and wp_url not in href:
            external_links.append(href)
    external_link_count = len(external_links)

    # 4. Meta title and description lengths
    meta_title_len = len(meta_title) if meta_title else 0
    meta_desc_len = len(meta_desc) if meta_desc else 0

    # 5. Keyword metrics
    slug_words = slug.split("-")
    VN_STOPWORDS = {"cach", "huong-dan", "la-gi", "tot-nhat", "meo", "bat-mi", "tren"}
    filtered = [w for w in slug_words if w not in VN_STOPWORDS]
    main_keyword_guess = " ".join(filtered) if filtered else slug.replace("-", " ")
    word_count = len(content.split())

    try:
        keyword_occurrences = len(re.findall(re.escape(main_keyword_guess), content, re.IGNORECASE))
    except Exception:
        keyword_occurrences = content.lower().count(main_keyword_guess.lower())
    keyword_density = round((keyword_occurrences / word_count) * 100, 2) if word_count > 0 else 0.0

    # 6. Preview 200w
    content_preview_200w = " ".join(content.split()[:200])

    # 7. Post type hints
    post_type_hint = "standalone"
    pillar_topic_hint = "N/A"
    pillar_map = config.get("pillar_map")
    if pillar_map and isinstance(pillar_map, dict):
        for key, val in pillar_map.items():
            if slug in key or (val and isinstance(val, dict) and slug in val.get("slug", "")):
                post_type_hint = val.get("type", "standalone")
                pillar_topic_hint = val.get("pillar", "N/A")
                break

    # 8. Expected LSI and Entities
    topic_data = detect_topic_entities(slug, title)
    post_intent = topic_data.get("post_intent") if topic_data else None
    if not post_intent:
        post_intent = detect_post_intent(slug, headings)

    if topic_data:
        expected_entities = ", ".join(topic_data["expected_entities"])
        expected_lsi = ", ".join(topic_data["expected_lsi"])
    else:
        expected_entities, expected_lsi = await get_expected_terms(title, slug, config)

    headings_text = "\n".join(
        f"  {'  ' * (int(h['level'][1])-1)}{h['level'].upper()}: {h['text']}"
        for h in headings
    )
    internal_links_text = "\n".join(
        f"  [{l['text']}]({l['href']})" for l in internal_links[:20]
    ) or "  (không có internal link)"

    # Truncate content with smart strategy
    words = content.split()
    if word_count <= 3000:
        truncated_content = content
    elif word_count <= 6000:
        truncated_content = (
            " ".join(words[:2000]) + "\n\n[...]\n\n" +
            " ".join(words[word_count//2 - 250 : word_count//2 + 250]) +
            "\n\n[...]\n\n" +
            " ".join(words[-500:])
        )
    else:
        truncated_content = (
            " ".join(words[:2500]) + "\n\n[--- phần giữa lược bỏ ---]\n\n" +
            " ".join(words[-800:])
        )

    user_prompt = AUDIT_USER_PROMPT.format(
        url=url, slug=slug, post_type_hint=post_type_hint, pillar_topic_hint=pillar_topic_hint,
        post_intent=post_intent,
        word_count=word_count, h1_count=h1_count, h2_count=h2_count, h3_count=h3_count,
        internal_link_count=internal_link_count, external_link_count=external_link_count,
        image_count=image_count, images_without_alt=images_without_alt,
        meta_title=meta_title, meta_title_len=meta_title_len,
        meta_desc=meta_desc, meta_desc_len=meta_desc_len,
        main_keyword_guess=main_keyword_guess, keyword_density=keyword_density,
        keyword_occurrences=keyword_occurrences, content_preview_200w=content_preview_200w,
        headings_text=headings_text, internal_links_text=internal_links_text,
        expected_entities=expected_entities, expected_lsi=expected_lsi,
        content=truncated_content, pillar_context=pillar_context or "",
        recent_posts_context=recent_posts_context or "  (Không tìm thấy danh sách bài viết khác trên site)",
    )

    fallback_keys = config.get('fallback_keys') or {}

    import asyncio
    response_text = await asyncio.to_thread(
        call_with_fallback,
        messages=[
            {"role": "system", "content": AUDIT_SYSTEM_PROMPT},
            {"role": "user", "content": user_prompt},
        ],
        config=config,
        fallback_keys=fallback_keys,
        temperature=0.2,
        max_tokens=3000,
        model_override=model_override,
    )

    # Clean and parse JSON
    raw_text = response_text.strip()
    if raw_text.startswith("```"):
        raw_text = raw_text.split("```")[1]
        if raw_text.startswith("json"):
            raw_text = raw_text[4:]
    if raw_text.endswith("```"):
        raw_text = raw_text[:-3]

    # Save raw LLM response to file for easy debugging/inspection
    try:
        with open("/opt/socialflow/hermes-api/raw_audit_response.log", "w", encoding="utf-8") as lf:
            lf.write(response_text)
        logger.info("[WP Audit] Raw LLM response saved to raw_audit_response.log")
    except Exception as log_err:
        logger.warning(f"[WP Audit] Failed to save raw response log: {log_err}")

    result = json.loads(raw_text.strip())

    # Calculate scores based on the checklist
    chk = result.get("checklist", {})
    if not isinstance(chk, dict):
        chk = {}

    seo_chk = chk.get("seo", {}) if isinstance(chk.get("seo"), dict) else {}
    geo_chk = chk.get("geo", {}) if isinstance(chk.get("geo"), dict) else {}
    pc_chk = chk.get("pillar_cluster", {}) if isinstance(chk.get("pillar_cluster"), dict) else {}
    sem_chk = chk.get("semantic", {}) if isinstance(chk.get("semantic"), dict) else {}

    seo = sum(val[1] for k, val in SEO_CHECKLIST.items() if seo_chk.get(k) is True)
    geo = sum(val[1] for k, val in GEO_CHECKLIST.items() if geo_chk.get(k) is True)
    pillar_cluster = sum(val[1] for k, val in PILLAR_CLUSTER_CHECKLIST.items() if pc_chk.get(k) is True)
    semantic = sum(val[1] for k, val in SEMANTIC_CHECKLIST.items() if sem_chk.get(k) is True)

    # Normalize within 0-25
    seo = max(0, min(25, seo))
    geo = max(0, min(25, geo))
    pillar_cluster = max(0, min(25, pillar_cluster))
    semantic = max(0, min(25, semantic))

    # Construct checklist_results for frontend
    result["checklist_results"] = {
        "seo": [{"key": k, "label": val[0], "points": val[1], "passed": seo_chk.get(k) is True} for k, val in SEO_CHECKLIST.items()],
        "geo": [{"key": k, "label": val[0], "points": val[1], "passed": geo_chk.get(k) is True} for k, val in GEO_CHECKLIST.items()],
        "pillar_cluster": [{"key": k, "label": val[0], "points": val[1], "passed": pc_chk.get(k) is True} for k, val in PILLAR_CLUSTER_CHECKLIST.items()],
        "semantic": [{"key": k, "label": val[0], "points": val[1], "passed": sem_chk.get(k) is True} for k, val in SEMANTIC_CHECKLIST.items()]
    }

    result["score_breakdown"] = {
        "seo": seo,
        "seo_score": seo,
        "geo": geo,
        "geo_score": geo,
        "pillar_cluster": pillar_cluster,
        "semantic": semantic,
        "semantic_score": semantic
    }

    # Update total score
    result["audit_score"] = seo + geo + pillar_cluster + semantic

    # Suggestions post-processing and normalization
    if "suggestions" not in result or not isinstance(result["suggestions"], dict):
        result["suggestions"] = {}

    sug = result["suggestions"]

    # (1) Normalize opening_paragraph
    op = sug.get("opening_paragraph") or sug.get("intro_paragraph") or sug.get("opening") or sug.get("intro") or sug.get("opening_paragraph_suggestion")
    if op:
        sug["opening_paragraph"] = op

    # (2) Validate Meta Title length
    mt = sug.get("meta_title", "")
    if mt and len(mt) > 60:
        sug["meta_title"] = None
        sug["meta_title_raw"] = mt
        sug["meta_title_error"] = f"LLM trả về {len(mt)} ký tự — cần viết lại thủ công"

    # (3) Validate Meta Description length
    md = sug.get("meta_description", "")
    if md:
        # Strip trailing length tag e.g. "(156 ký tự)" to validate real length
        clean_md = re.sub(r'\s*\(\d+\s*ký\s*tự\)\s*$', '', md).strip()
        if len(clean_md) < 130:
            result["audit_warnings"] = result.get("audit_warnings", [])
            result["audit_warnings"].append(
                f"Meta description đề xuất quá ngắn ({len(clean_md)} ký tự). LLM không tuân theo prompt. Cần viết lại thủ công."
            )

    # (4) Force minimum FAQ
    faq = sug.get("faq_block", [])
    if not isinstance(faq, list):
        faq = []
    if len(faq) < 5:
        # Clean keyword: use LLM's main_keyword or fallback
        kw_clean = result.get("main_keyword") or (topic_data.get("topic_label") if topic_data else None) or main_keyword_guess
        auto_faq = generate_auto_faq(
            post_intent=post_intent,
            main_keyword=kw_clean,
            existing_faq_count=len(faq)
        )
        faq.extend(auto_faq)
        sug["faq_block"] = faq
        result["audit_warnings"] = result.get("audit_warnings", [])
        result["audit_warnings"].append(
            f"FAQ tự động bổ sung {len(auto_faq)} câu để đạt minimum 5"
        )

    # (5) Programmatic missing entities & LSI mapping
    if topic_data:
        content_norm = normalize(content)
        
        # Programmatic entities check
        missing_ents = [
            e for e in topic_data.get("expected_entities", [])
            if normalize(e) not in content_norm
        ]
        sug["missing_entities"] = missing_ents
        
        # Programmatic LSI check
        missing_lsis = [
            l for l in topic_data.get("expected_lsi", [])
            if normalize(l) not in content_norm
        ]
        sug["missing_lsi"] = missing_lsis
        
        result["audit_warnings"] = result.get("audit_warnings", [])
        result["audit_warnings"].append(
            "Đã đồng bộ và tự động quét Entity/LSI bị thiếu theo TOPIC_ENTITY_MAP (Unicode normalized)"
        )
    else:
        # Fallback to LLM lists
        if "missing_entities" not in sug or not isinstance(sug["missing_entities"], list):
            sug["missing_entities"] = []
        if "missing_lsi" not in sug or not isinstance(sug["missing_lsi"], list):
            sug["missing_lsi"] = sug.get("missing_lsi_keywords") or []

    # (6) Dedup internal_links_to_add with existing links in the post
    if "internal_links_to_add" in sug and isinstance(sug["internal_links_to_add"], list):
        existing_hrefs = {str(lnk.get("href", "")).lower().strip().rstrip("/") for lnk in internal_links if lnk.get("href")}
        
        deduped_links = []
        for item in sug["internal_links_to_add"]:
            if not isinstance(item, dict):
                continue
            item_url = str(item.get("url") or item.get("target") or "").lower().strip().rstrip("/")
            
            # Check if this URL is already linked in the post
            is_duplicate = False
            for eh in existing_hrefs:
                if eh and (eh in item_url or item_url in eh):
                    is_duplicate = True
                    break
            
            if not is_duplicate:
                deduped_links.append(item)
                
        sug["internal_links_to_add"] = deduped_links

    return result

@app.get("/hermes/wp/resolve")
async def wp_resolve_post(
    url: str = "",
    slug: str = "",
    site_idx: int = 0,
    x_agent_key: str = Header(None)
):
    verify_key(x_agent_key)
    config = await load_config()
    client = get_wp_client(config, site_idx)
    
    resolved_slug = slug
    if url:
        # Extract slug: handle trailing slash, query parameters etc.
        clean_url = url.split("?")[0].rstrip("/")
        resolved_slug = clean_url.split("/")[-1]
        
    if not resolved_slug:
        raise HTTPException(400, "Không thể nhận diện slug từ URL cung cấp")
        
    import httpx
    async with httpx.AsyncClient(follow_redirects=True) as http_client:
        r = await http_client.get(
            f"{client.base}/posts",
            headers=client.headers,
            params={"slug": resolved_slug, "_fields": "id,title,slug,link,date,modified,categories,tags,excerpt,meta"},
            timeout=15,
        )
        r.raise_for_status()
        posts = r.json()
        if not posts:
            raise HTTPException(404, f"Không tìm thấy bài viết nào với slug: '{resolved_slug}'")
        return {"post": posts[0]}

@app.get("/hermes/wp/posts")
async def wp_list_posts(
    page: int = 1,
    per_page: int = 20,
    search: str = "",
    category_id: Optional[int] = None,
    site_idx: int = 0,
    x_agent_key: str = Header(None)
):
    verify_key(x_agent_key)
    config = await load_config()
    client = get_wp_client(config, site_idx)
    posts = await client.list_posts(
        per_page=per_page,
        page=page,
        search=search or None,
        categories=[category_id] if category_id else None,
    )
    return {"posts": posts, "page": page, "per_page": per_page}

@app.post("/hermes/wp/audit/{post_id}")
async def wp_audit_post(post_id: int, site_idx: int = 0, force: bool = False, model: str = None, x_agent_key: str = Header(None)):
    verify_key(x_agent_key)
    config = await load_config()
    client = get_wp_client(config, site_idx)

    # 1. Check cache first if not forced and no model override is requested
    if not force and not model:
        try:
            pool = await get_pool()
            cached = await pool.fetchrow(
                "SELECT audit_data FROM wp_audit_results WHERE site_idx = $1 AND post_id = $2",
                site_idx, post_id
            )
            if cached:
                audit_data = cached["audit_data"]
                # Fetch post info to return complete data structure
                post = await client.get_post(post_id)
                title = post.get("title", {}).get("rendered", "")
                url = post.get("link", "")
                logger.info(f"[WP Audit] Returning cached audit result for site={site_idx} post={post_id}")
                return {
                    "post_id": post_id,
                    "title": title,
                    "url": url,
                    "audit": audit_data,
                    "site_idx": site_idx,
                    "cached": True
                }
        except Exception as e:
            logger.warning(f"[WP Audit] Failed to read from cache: {e}")

    # Assign default model if not specified
    if not model:
        model = "kimi:kimi-k2-thinking"

    # Fetch bài viết if not cached or forced
    post = await client.get_post(post_id)
    title   = post.get("title", {}).get("rendered", "")
    raw_html = post.get("content", {}).get("rendered", "")
    excerpt  = post.get("excerpt", {}).get("rendered", "")
    slug    = post.get("slug", "")
    url     = post.get("link", "")

    # 2. Strip HTML → plain text để LLM đọc
    soup = BeautifulSoup(raw_html, "html.parser")
    content_text = soup.get_text(separator="\n", strip=True)
    
    # 3. Extract heading structure
    headings = []
    if title:
        headings.append({"level": "h1", "text": title})
    for tag in soup.find_all(["h1", "h2", "h3", "h4"]):
        lvl = tag.name.lower()
        txt = tag.get_text(strip=True)
        # Avoid duplicating the H1 if the body content already contains the title as H1
        if lvl == "h1" and title and txt.lower() == title.lower():
            continue
        headings.append({"level": lvl, "text": txt})
    
    # 4. Extract internal links
    internal_links = []
    wp_url = config.get("wp_url", "")
    for a in soup.find_all("a", href=True):
        href = a["href"]
        if wp_url and wp_url in href:
            internal_links.append({"text": a.get_text(strip=True), "href": href})

    # 5. Extract meta title and description (support RankMath, Yoast, etc.)
    meta_title = ""
    meta_desc = ""

    # Try public HTML fetch first (works for all published posts regardless of plugin)
    public_url = post.get("link", "")
    if public_url:
        try:
            logger.info(f"[WP Audit] Attempting to fetch public HTML for meta tags: {public_url}")
            headers = {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
            # Fast timeout to avoid blocking if page is private or down
            with httpx.Client(follow_redirects=True, timeout=3.0) as http_client:
                r = http_client.get(public_url, headers=headers)
                if r.status_code == 200:
                    soup_html = BeautifulSoup(r.text, 'html.parser')
                    title_tag = soup_html.find('title')
                    if title_tag:
                        t_text = title_tag.get_text(strip=True)
                        if "page not found" not in t_text.lower() and "404" not in t_text:
                            meta_title = t_text
                    
                    desc_tag = soup_html.find('meta', attrs={'name': 'description'})
                    if desc_tag and desc_tag.has_attr('content'):
                        meta_desc = desc_tag['content']
                    
                    logger.info(f"[WP Audit] Successfully extracted public meta tags. Title: {meta_title[:50]}..., Desc: {meta_desc[:50]}...")
        except Exception as e:
            logger.warning(f"[WP Audit] Failed to fetch public HTML: {e}")

    # Fallback to Yoast or standard WP fields if public fetch didn't yield anything
    if not meta_title or not meta_desc:
        yoast = post.get("yoast_head_json", {}) or {}
        if not meta_title:
            meta_title = yoast.get("title", "") or post.get("title", {}).get("rendered", "")
        if not meta_desc:
            meta_desc = yoast.get("description", "") or post.get("excerpt", {}).get("rendered", "")
        logger.info(f"[WP Audit] Fallback meta tags used. Title: {meta_title[:50]}..., Desc: {meta_desc[:50]}...")

    # 6. Xây dựng context về pillar/cluster
    pillar_context = ""
    pillar_map = config.get("pillar_map")
    if pillar_map:
        pillar_context = f"Pillar map của site: {json.dumps(pillar_map, ensure_ascii=False)}"

    # 6.5 Fetch 50 bài viết mới nhất trên site để làm context link thực tế
    recent_posts = []
    try:
        recent_posts = await client.list_posts(per_page=50, status="publish")
    except Exception as e:
        logger.warning(f"[WP Audit] Failed to fetch recent posts for link context: {e}")

    recent_posts_context = ""
    if recent_posts:
        recent_posts_context = "Các bài viết mới nhất trên site có sẵn để liên kết:\n" + "\n".join(
            f"- Tiêu đề: {p.get('title', {}).get('rendered', p.get('title', ''))} | Link: {p.get('link', '')}"
            for p in recent_posts
        )

    # 7. Gọi LLM audit
    audit_result = await run_audit_llm(
        title=title,
        slug=slug,
        url=url,
        content=content_text,
        headings=headings,
        internal_links=internal_links,
        meta_title=meta_title,
        meta_desc=meta_desc,
        excerpt=excerpt,
        pillar_context=pillar_context,
        config=config,
        raw_html=raw_html,
        model_override=model,
        recent_posts_context=recent_posts_context
    )

    # 8. Save/upsert result in database
    try:
        pool = await get_pool()
        await pool.execute(
            """
            INSERT INTO wp_audit_results (site_idx, post_id, audit_data, updated_at)
            VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
            ON CONFLICT (site_idx, post_id)
            DO UPDATE SET audit_data = EXCLUDED.audit_data, updated_at = CURRENT_TIMESTAMP
            """,
            site_idx, post_id, audit_result
        )
        logger.info(f"[WP Audit] Saved audit result for site={site_idx} post={post_id} to DB")
        
        # Record to history for tracking trends
        try:
            audit_score = audit_result.get("audit_score")
            sb = audit_result.get("score_breakdown") or {}
            await pool.execute(
                """
                INSERT INTO audit_score_history (url, post_id, audit_score, score_seo, score_geo, score_pillar, score_semantic, audit_data)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                """,
                url, post_id, audit_score, sb.get("seo"), sb.get("geo"), sb.get("pillar_cluster") or sb.get("pillar"), sb.get("semantic"), json.dumps(audit_result)
            )
            logger.info(f"[WP Audit] Recorded score history for post={post_id} score={audit_score}")
        except Exception as e_hist:
            logger.warning(f"[WP Audit] Failed to save audit history: {e_hist}")
    except Exception as e:
        logger.error(f"[WP Audit] Failed to save result to DB: {e}")

    return {
        "post_id": post_id,
        "title": title,
        "url": url,
        "audit": audit_result,
        "site_idx": site_idx,
        "cached": False
    }


@app.put("/hermes/wp/apply/{post_id}")
async def wp_apply_suggestions(post_id: int, site_idx: int = 0, req_data: dict = Body(...), x_agent_key: str = Header(None)):
    verify_key(x_agent_key)
    config = await load_config()
    client = get_wp_client(config, site_idx)
    res = await client.update_post(post_id, req_data)
    return {"ok": True, "result": res}

@app.get("/hermes/wp/categories")
async def wp_list_categories(site_idx: int = 0, x_agent_key: str = Header(None)):
    verify_key(x_agent_key)
    config = await load_config()
    client = get_wp_client(config, site_idx)
    categories = await client.get_categories()
    return {"categories": categories}

@app.delete('/feedback')
async def delete_feedback(confirm: str = '', x_agent_key: str = Header(None)):
    """Nuclear option: delete ALL hermes_feedback. Requires ?confirm=XOAHET."""
    verify_key(x_agent_key)
    if confirm != 'XOAHET':
        raise HTTPException(400, 'Must include ?confirm=XOAHET to proceed')
    pool = await get_pool()
    try:
        result = await pool.execute('DELETE FROM hermes_feedback')
        count = int(result.split()[-1]) if result else 0
    except Exception as e:
        raise HTTPException(500, f'Delete failed: {e}')
    return {'ok': True, 'deleted_rows': count}

# ── Legacy /agent-chat kept for backward compat (not used) ─
@app.post('/agent-chat')
async def agent_chat(req: Dict[str, Any] = Body(...), x_agent_key: str = Header(None)):
    verify_key(x_agent_key)
    raise HTTPException(501, 'agent-chat disabled in v2 — use /generate instead')

# ── Google Analytics 4 & Search Console Dashboard APIs ───────
import uuid
import urllib.parse
from datetime import datetime, timedelta

_sync_jobs = {}

def get_google_access_token(creds_json: str, scopes: list) -> str:
    from google.oauth2 import service_account
    import google.auth.transport.requests
    info = json.loads(creds_json)
    creds = service_account.Credentials.from_service_account_info(info, scopes=scopes)
    request = google.auth.transport.requests.Request()
    creds.refresh(request)
    return creds.token

async def fetch_gsc_data(site_url: str, creds_json: str, days: int = 28) -> list:
    access_token = get_google_access_token(creds_json, ["https://www.googleapis.com/auth/webmasters.readonly"])
    headers = {
        "Authorization": f"Bearer {access_token}",
        "Content-Type": "application/json"
    }
    body = {
        "startDate": (datetime.now() - timedelta(days=days)).strftime("%Y-%m-%d"),
        "endDate": datetime.now().strftime("%Y-%m-%d"),
        "dimensions": ["page"],
        "rowLimit": 500,
        "dataState": "final",
    }
    encoded_site_url = urllib.parse.quote_plus(site_url)
    url = f"https://www.googleapis.com/webmasters/v3/sites/{encoded_site_url}/searchAnalytics/query"
    async with httpx.AsyncClient() as client:
        r = await client.post(url, headers=headers, json=body, timeout=30)
        r.raise_for_status()
        return r.json().get("rows", [])

async def fetch_gsc_queries_for_page(page_url: str, site_url: str, creds_json: str) -> list:
    access_token = get_google_access_token(creds_json, ["https://www.googleapis.com/auth/webmasters.readonly"])
    headers = {
        "Authorization": f"Bearer {access_token}",
        "Content-Type": "application/json"
    }
    body = {
        "startDate": (datetime.now() - timedelta(days=28)).strftime("%Y-%m-%d"),
        "endDate": datetime.now().strftime("%Y-%m-%d"),
        "dimensions": ["query"],
        "dimensionFilterGroups": [
            {
                "filters": [
                    {
                        "dimension": "page",
                        "operator": "equals",
                        "expression": page_url
                    }
                ]
            }
        ],
        "rowLimit": 20,
        "dataState": "final"
    }
    encoded_site_url = urllib.parse.quote_plus(site_url)
    url = f"https://www.googleapis.com/webmasters/v3/sites/{encoded_site_url}/searchAnalytics/query"
    async with httpx.AsyncClient() as client:
        r = await client.post(url, headers=headers, json=body, timeout=20)
        r.raise_for_status()
        return r.json().get("rows", [])

async def fetch_ga4_data(property_id: str, creds_json: str, days: int = 28) -> list:
    access_token = get_google_access_token(creds_json, ["https://www.googleapis.com/auth/analytics.readonly"])
    headers = {
        "Authorization": f"Bearer {access_token}",
        "Content-Type": "application/json"
    }
    clean_property_id = property_id.replace("properties/", "")
    url = f"https://analyticsdata.googleapis.com/v1beta/properties/{clean_property_id}:runReport"
    body = {
        "dateRanges": [{"startDate": f"{days}daysAgo", "endDate": "today"}],
        "dimensions": [{"name": "pagePath"}],
        "metrics": [
            {"name": "sessions"},
            {"name": "averageSessionDuration"},
            {"name": "bounceRate"},
            {"name": "screenPageViews"}
        ],
        "limit": 500
    }
    async with httpx.AsyncClient() as client:
        r = await client.post(url, headers=headers, json=body, timeout=30)
        r.raise_for_status()
        
        ga4_rows = []
        res_data = r.json()
        for row in res_data.get("rows", []):
            path = row["dimensionValues"][0]["value"]
            ga4_rows.append({
                "pagePath": path,
                "sessions": int(row["metricValues"][0]["value"] or 0),
                "averageSessionDuration": float(row["metricValues"][1]["value"] or 0.0),
                "bounceRate": float(row["metricValues"][2]["value"] or 0.0),
                "screenPageViews": int(row["metricValues"][3]["value"] or 0),
            })
        return ga4_rows

def normalize_path(path: str) -> str:
    p = (path or "").strip().lower()
    if p.startswith("http://") or p.startswith("https://"):
        parts = p.split("/", 3)
        p = "/" + parts[3] if len(parts) > 3 else "/"
    p = p.split("?")[0]
    if p != "/" and p.endswith("/"):
        p = p[:-1]
    return p

async def find_post_id_by_url_or_slug(pool, url: str, slug: str):
    try:
        row = await pool.fetchrow(
            "SELECT post_id FROM wp_audit_results WHERE audit_data->>'url' = $1 OR audit_data->'post'->>'link' = $1",
            url
        )
        if row:
            return row["post_id"]
        row = await pool.fetchrow(
            "SELECT post_id FROM wp_audit_results WHERE audit_data->'post'->>'slug' = $1",
            slug
        )
        if row:
            return row["post_id"]
    except Exception as e:
        logger.warning(f"Error resolving post_id for {url}: {e}")
    return None

async def run_sync_background_job(job_id: str, config: dict):
    _sync_jobs[job_id] = {"status": "running", "progress": 10, "error": None}
    try:
        pool = await get_pool()
        site_url = config.get("gsc_site_url")
        gsc_creds = config.get("gsc_credentials_json")
        if not site_url or not gsc_creds:
            raise ValueError("Google Search Console credentials/site_url not configured")

        _sync_jobs[job_id]["progress"] = 30
        gsc_rows = await fetch_gsc_data(site_url, gsc_creds, days=28)

        ga4_property = config.get("ga4_property_id")
        ga4_creds = config.get("ga4_credentials_json")
        ga4_rows = []
        if ga4_property and ga4_creds:
            _sync_jobs[job_id]["progress"] = 60
            try:
                ga4_rows = await fetch_ga4_data(ga4_property, ga4_creds, days=28)
            except Exception as ga4_err:
                logger.warning(f"Failed to fetch GA4 data: {ga4_err}")
                
        _sync_jobs[job_id]["progress"] = 80
        ga4_map = {normalize_path(row["pagePath"]): row for row in ga4_rows}

        for row in gsc_rows:
            url = row["keys"][0]
            path = normalize_path(url.replace(site_url.rstrip("/"), ""))
            ga4 = ga4_map.get(path, {})

            slug = url.rstrip("/").split("/")[-1]
            post_id = await find_post_id_by_url_or_slug(pool, url, slug)
            page_title = slug.replace("-", " ").title()

            await pool.execute(
                """
                INSERT INTO page_analytics_cache (
                    url, post_id, page_title, gsc_clicks, gsc_impressions, gsc_ctr, gsc_position,
                    ga4_sessions, ga4_avg_time_sec, ga4_bounce_rate, ga4_pageviews, fetched_at
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, CURRENT_TIMESTAMP)
                ON CONFLICT (url) DO UPDATE SET
                    post_id = EXCLUDED.post_id,
                    gsc_clicks = EXCLUDED.gsc_clicks,
                    gsc_impressions = EXCLUDED.gsc_impressions,
                    gsc_ctr = EXCLUDED.gsc_ctr,
                    gsc_position = EXCLUDED.gsc_position,
                    ga4_sessions = EXCLUDED.ga4_sessions,
                    ga4_avg_time_sec = EXCLUDED.ga4_avg_time_sec,
                    ga4_bounce_rate = EXCLUDED.ga4_bounce_rate,
                    ga4_pageviews = EXCLUDED.ga4_pageviews,
                    fetched_at = CURRENT_TIMESTAMP
                """,
                url, post_id, page_title,
                row.get("clicks", 0), row.get("impressions", 0), row.get("ctr", 0.0), row.get("position", 0.0),
                ga4.get("sessions", 0), int(ga4.get("averageSessionDuration", 0.0)), ga4.get("bounceRate", 0.0), ga4.get("screenPageViews", 0)
            )

        _sync_jobs[job_id]["status"] = "completed"
        _sync_jobs[job_id]["progress"] = 100
        logger.info(f"[WP Audit Sync] Synchronized {len(gsc_rows)} pages")
    except Exception as e:
        logger.error(f"[WP Audit Sync] Sync job {job_id} failed: {e}")
        _sync_jobs[job_id]["status"] = "failed"
        _sync_jobs[job_id]["error"] = str(e)

def get_ctr_benchmark(position: float) -> float:
    pos = max(1.0, position)
    if pos <= 1.5: return 0.30
    if pos <= 2.5: return 0.15
    if pos <= 3.5: return 0.10
    if pos <= 4.5: return 0.07
    if pos <= 6.0: return 0.05
    if pos <= 8.0: return 0.03
    if pos <= 10.0: return 0.02
    return 0.01

def classify_page_opportunity(impr: int, ctr: float, pos: float, audit_score: Optional[int]) -> str:
    ctr_bench = get_ctr_benchmark(pos)
    is_low_ctr = ctr < ctr_bench
    is_high_impr = impr >= 1000
    is_low_audit = audit_score is None or audit_score < 70
    
    if is_high_impr and is_low_ctr and is_low_audit:
        return "fix_gap"
    if is_high_impr and not is_low_ctr and is_low_audit:
        return "improve_content"
    if not is_high_impr and audit_score is not None and audit_score >= 70:
        return "promote"
    return "ok"

@app.post("/hermes/dashboard/sync")
async def trigger_analytics_sync(background_tasks: BackgroundTasks, x_agent_key: str = Header(None)):
    verify_key(x_agent_key)
    config = await load_config()
    job_id = str(uuid.uuid4())
    background_tasks.add_task(run_sync_background_job, job_id, config)
    return {"job_id": job_id, "status": "running"}

@app.get("/hermes/dashboard/sync/status/{job_id}")
async def get_sync_status(job_id: str, x_agent_key: str = Header(None)):
    verify_key(x_agent_key)
    job = _sync_jobs.get(job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    return job

@app.get("/hermes/dashboard/overview")
async def get_dashboard_overview(sort_by: str = "priority", limit: int = 100, page: int = 1, x_agent_key: str = Header(None)):
    verify_key(x_agent_key)
    pool = await get_pool()
    
    rows = await pool.fetch("""
        SELECT 
            c.url,
            c.post_id,
            c.page_title,
            c.gsc_clicks,
            c.gsc_impressions,
            c.gsc_ctr,
            c.gsc_position,
            c.gsc_top_queries,
            c.ga4_sessions,
            c.ga4_avg_time_sec,
            c.ga4_bounce_rate,
            c.ga4_pageviews,
            c.fetched_at,
            r.audit_data as last_audit_data
        FROM page_analytics_cache c
        LEFT JOIN wp_audit_results r ON 
            (c.post_id IS NOT NULL AND c.post_id = r.post_id)
            OR (c.url = r.audit_data->>'url')
            OR (c.url = r.audit_data->'post'->>'link')
    """)
    
    results = []
    for row in rows:
        item = dict(row)
        audit_data = item.pop("last_audit_data", None)
        
        if audit_data and isinstance(audit_data, str):
            try:
                audit_data = json.loads(audit_data)
            except:
                audit_data = None
                
        score = None
        score_breakdown = {}
        if audit_data:
            score = audit_data.get("audit_score")
            score_breakdown = audit_data.get("score_breakdown") or {}
            
        item["audit_score"] = score
        item["score_seo"] = score_breakdown.get("seo_score") or score_breakdown.get("seo")
        item["score_geo"] = score_breakdown.get("geo_score") or score_breakdown.get("geo")
        item["score_pillar"] = score_breakdown.get("pillar_cluster") or score_breakdown.get("pillar")
        item["score_semantic"] = score_breakdown.get("semantic_score") or score_breakdown.get("semantic")
        
        impr = item["gsc_impressions"] or 0
        ctr = item["gsc_ctr"] or 0.0
        pos = item["gsc_position"] or 10.0
        ctr_bench = get_ctr_benchmark(pos)
        
        ctr_factor = max(0.0, 1.0 - (ctr / ctr_bench)) if ctr_bench > 0 else 1.0
        audit_factor = 1.0 - ((score or 0) / 100.0)
        
        item["priority_score"] = impr * ctr_factor * audit_factor
        item["opportunity_group"] = classify_page_opportunity(impr, ctr, pos, score)
        results.append(item)
        
    if sort_by == "priority":
        results.sort(key=lambda x: x["priority_score"], reverse=True)
    elif sort_by == "impressions":
        results.sort(key=lambda x: x["gsc_impressions"] or 0, reverse=True)
    elif sort_by == "clicks":
        results.sort(key=lambda x: x["gsc_clicks"] or 0, reverse=True)
    elif sort_by == "audit_score":
        results.sort(key=lambda x: x["audit_score"] if x["audit_score"] is not None else -1, reverse=True)
    elif sort_by == "position":
        results.sort(key=lambda x: x["gsc_position"] if x["gsc_position"] is not None else 999.0)
        
    total_count = len(results)
    start_idx = (page - 1) * limit
    paginated_results = results[start_idx : start_idx + limit]
    
    group_totals = {"fix_gap": 0, "improve_content": 0, "promote": 0, "ok": 0}
    for item in results:
        g = item["opportunity_group"]
        if g in group_totals:
            group_totals[g] += 1
            
    return {
        "pages": paginated_results,
        "total": total_count,
        "page": page,
        "per_page": limit,
        "group_totals": group_totals
    }

@app.get("/hermes/dashboard/page")
async def get_dashboard_page(url: str, x_agent_key: str = Header(None)):
    verify_key(x_agent_key)
    pool = await get_pool()
    
    row = await pool.fetchrow("SELECT * FROM page_analytics_cache WHERE url = $1", url)
    if not row:
        raise HTTPException(404, "Page not found in cache")
        
    page_data = dict(row)
    
    top_queries = page_data.get("gsc_top_queries")
    if top_queries and isinstance(top_queries, str):
        try:
            top_queries = json.loads(top_queries)
        except:
            top_queries = None
            
    config = await load_config()
    creds_json = config.get("gsc_credentials_json")
    site_url = config.get("gsc_site_url")
    
    if creds_json and site_url and not top_queries:
        try:
            top_queries = await fetch_gsc_queries_for_page(url, site_url, creds_json)
            await pool.execute(
                "UPDATE page_analytics_cache SET gsc_top_queries = $1 WHERE url = $2",
                json.dumps(top_queries), url
            )
            page_data["gsc_top_queries"] = top_queries
        except Exception as e:
            logger.warning(f"Failed to fetch live queries for {url}: {e}")
            page_data["gsc_top_queries"] = []
            
    history_rows = await pool.fetch(
        "SELECT audit_score, audited_at FROM audit_score_history WHERE url = $1 ORDER BY audited_at ASC",
        url
    )
    history = [{"score": r["audit_score"], "date": r["audited_at"].strftime("%Y-%m-%d")} for r in history_rows]
    
    row_audit = await pool.fetchrow(
        "SELECT audit_data FROM wp_audit_results WHERE audit_data->>'url' = $1 OR audit_data->'post'->>'link' = $1",
        url
    )
    suggestions = {}
    audit_score = None
    if row_audit:
        audit_data = json.loads(row_audit["audit_data"]) if isinstance(row_audit["audit_data"], str) else row_audit["audit_data"]
        suggestions = audit_data.get("suggestions") or {}
        audit_score = audit_data.get("audit_score")
        
    return {
        "page": page_data,
        "history": history,
        "suggestions": suggestions,
        "audit_score": audit_score
    }

class CompareRequest(BaseModel):
    urls: List[str]

@app.post("/hermes/dashboard/compare")
async def compare_pages(req: CompareRequest, x_agent_key: str = Header(None)):
    verify_key(x_agent_key)
    pool = await get_pool()
    
    results = []
    for url in req.urls:
        row_cache = await pool.fetchrow("SELECT * FROM page_analytics_cache WHERE url = $1", url)
        row_audit = await pool.fetchrow(
            "SELECT audit_data FROM wp_audit_results WHERE audit_data->>'url' = $1 OR audit_data->'post'->>'link' = $1",
            url
        )
        
        cache_data = dict(row_cache) if row_cache else {"url": url}
        audit_data = {}
        if row_audit:
            audit_data = json.loads(row_audit["audit_data"]) if isinstance(row_audit["audit_data"], str) else row_audit["audit_data"]
            
        if audit_data:
            audit_data.pop("raw_html", None)
            
        results.append({
            "cache": cache_data,
            "audit": audit_data
        })
    return results

@app.get("/hermes/dashboard/opportunities")
async def get_dashboard_opportunities(x_agent_key: str = Header(None)):
    verify_key(x_agent_key)
    pool = await get_pool()
    
    rows = await pool.fetch("""
        SELECT 
            c.url,
            c.post_id,
            c.page_title,
            c.gsc_clicks,
            c.gsc_impressions,
            c.gsc_ctr,
            c.gsc_position,
            c.ga4_sessions,
            c.ga4_avg_time_sec,
            c.ga4_bounce_rate,
            c.ga4_pageviews,
            r.audit_data as last_audit_data
        FROM page_analytics_cache c
        LEFT JOIN wp_audit_results r ON 
            (c.post_id IS NOT NULL AND c.post_id = r.post_id)
            OR (c.url = r.audit_data->>'url')
            OR (c.url = r.audit_data->'post'->>'link')
    """)
    
    results = []
    for row in rows:
        item = dict(row)
        audit_data = item.pop("last_audit_data", None)
        
        if audit_data and isinstance(audit_data, str):
            try:
                audit_data = json.loads(audit_data)
            except:
                audit_data = None
                
        score = None
        suggestions = {}
        if audit_data:
            score = audit_data.get("audit_score")
            suggestions = audit_data.get("suggestions") or {}
            
        item["audit_score"] = score
        item["suggestions"] = suggestions
        
        impr = item["gsc_impressions"] or 0
        ctr = item["gsc_ctr"] or 0.0
        pos = item["gsc_position"] or 10.0
        ctr_bench = get_ctr_benchmark(pos)
        
        ctr_factor = max(0.0, 1.0 - (ctr / ctr_bench)) if ctr_bench > 0 else 1.0
        audit_factor = 1.0 - ((score or 0) / 100.0)
        
        item["priority_score"] = impr * ctr_factor * audit_factor
        results.append(item)
        
    results.sort(key=lambda x: x["priority_score"], reverse=True)
    top_20 = results[:20]
    
    fix_meta = []
    improve_content = []
    add_faq = []
    internal_links = []
    
    for item in top_20:
        url = item["url"]
        title = item["page_title"]
        score = item["audit_score"]
        pos = item["gsc_position"] or 10.0
        ctr = item["gsc_ctr"] or 0.0
        ctr_bench = get_ctr_benchmark(pos)
        
        page_summary = {
            "url": url,
            "title": title,
            "priority_score": item["priority_score"],
            "audit_score": score,
            "post_id": item["post_id"]
        }
        
        if ctr < ctr_bench:
            fix_meta.append(page_summary)
            
        if item["ga4_sessions"] > 0 and (item["ga4_bounce_rate"] > 0.60 or item["ga4_avg_time_sec"] < 90):
            improve_content.append(page_summary)
            
        faq = item["suggestions"].get("faq_block") or []
        if not faq or len(faq) < 5:
            add_faq.append(page_summary)
            
        links_to_add = item["suggestions"].get("internal_links_to_add") or []
        if links_to_add:
            internal_links.append(page_summary)
            
    return {
        "fix_meta": fix_meta,
        "improve_content": improve_content,
        "add_faq": add_faq,
        "internal_links": internal_links
    }

if __name__ == '__main__':
    port = int(os.getenv('HERMES_PORT', '8100'))
    logger.info('Starting Hermes API v2.0 on port %d', port)
    uvicorn.run(app, host='0.0.0.0', port=port, log_level='info')
