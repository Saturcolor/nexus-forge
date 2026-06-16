"""OpenAI Realtime API provider — WebSocket bidirectional proxy.

Exposes a single `proxy_session()` entrypoint that wires a client WS
(NCM Interpreter or any OpenAI-Realtime-compatible client) to OpenAI's
`wss://api.openai.com/v1/realtime` upstream.

Mercury is a transparent transport here: frames are forwarded as-is in
both directions, no protocol translation. The only interpretation Mercury
performs is extracting the `usage` block from `response.done` frames to
log billable turns to the dashboard DB.
"""
from providers.openai_realtime.backend import (
    connect_upstream,
    proxy_session,
    extract_usage,
)

__all__ = ["connect_upstream", "proxy_session", "extract_usage"]
