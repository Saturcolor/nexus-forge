-- Mastermind — Migration 013: drop legacy notify_telegram echo plumbing
-- Le toggle `scheduled_tasks.notify_telegram` et la colonne `task_runs.notified_telegram`
-- existaient pour pousser un écho post-run de la réponse de l'agent vers Telegram.
-- Désormais, l'agent contrôle la livraison via send_to_user (qui respecte le canal natif
-- de la session). L'écho post-run était un doublon → suppression.

ALTER TABLE scheduled_tasks DROP COLUMN IF EXISTS notify_telegram;
ALTER TABLE task_runs       DROP COLUMN IF EXISTS notified_telegram;
