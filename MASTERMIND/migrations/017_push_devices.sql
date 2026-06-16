-- 017_push_devices.sql
-- Canal push mobile (APNs (mobile)) — miroir de Telegram.
-- Registry des device tokens, alimenté par POST /api/push/register depuis l'app.
-- disabled=true => token mort (410 Unregistered / BadDeviceToken), purgé par PushModule.

CREATE TABLE IF NOT EXISTS push_devices (
  token        TEXT PRIMARY KEY,
  platform     TEXT NOT NULL DEFAULT 'ios',
  agent_id     TEXT,
  disabled     BOOLEAN NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_push_devices_active
  ON push_devices(last_seen_at DESC) WHERE disabled = false;
