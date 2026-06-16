/**
 * Checklist des chemins HTTP couverts par le mock (source de vérité pour le refacto).
 * Inclut admin.ts + fetches directs (LiveChatCard, queries useLlamacppInstanceLogs, ExtBenchPanel).
 *
 * Hors admin.ts:
 * - POST /admin/benchmark/chat-stream (SSE)
 * - GET /admin/llamacpp/logs-stream/:modelId (SSE)
 * - GET|POST /admin/toolcall15/*, /admin/bugfind15/*
 * - POST /admin/ext-bench/:benchId/start|stop
 *
 * admin.ts + fetch /api/voices:
 * Voir grep projet sur apiGet|apiPost|clientFetch dans admin.ts — tout est routé via mockRouter → handlers.
 */

export const MOCK_ENDPOINTS_VERSION = 1
