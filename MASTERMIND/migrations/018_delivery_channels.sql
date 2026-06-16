-- Per-task / per-source delivery channels override.
-- JSONB array de canaux de réveil ('["mobile","telegram"]') ou NULL = pas d'override
-- (la policy `delivery` de l'agent ou le comportement legacy s'appliquent).
-- Prioritaire sur la policy agent ET sur l'arg `channel` du LLM dans send_to_user
-- (résolution centrale : packages/backend/src/modules/agent/tools/deliver.ts resolveDelivery).

ALTER TABLE scheduled_tasks ADD COLUMN IF NOT EXISTS delivery_channels JSONB;
ALTER TABLE proactive_sources ADD COLUMN IF NOT EXISTS delivery_channels JSONB;
