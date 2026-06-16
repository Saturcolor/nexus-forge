-- Mastermind — Migration 015: per-task / per-source auto_deliver toggle
-- Avant : les filets de secours dans run.ts (proactive web autodeliver + telegram
-- autodeliver) livraient TOUJOURS le `fullResponse` final si l'agent oubliait
-- send_to_user. Aucun moyen pour le user de désactiver ce filet par routine.
--
-- Après : flag opt-out par scheduled_task / proactive_source. Default true (préserve
-- le comportement existant). Quand false, l'agent peut terminer son turn en silence
-- sur les paths "push" (proactive handler en chat web, ou run ciblant une session
-- Telegram). N'affecte PAS les tâches scheduled web simples — leur réponse passe
-- toujours par le streaming live.
--
-- Plumbing côté code :
--  - scheduler.executeTask passe task.autoDeliver à agentMod.run
--  - proactive-source.dispatchToAgent passe source.autoDeliver à agentMod.run
--  - scheduler.triggerEscalation hérite du flag du parent watcher run context
--  - run.ts gates sur les 2 fallbacks : proactive web (~l.2330) + telegram (~l.2370)
--  - sandbox autodeliver volontairement non gaté (orphan = bug, pas feature)

ALTER TABLE scheduled_tasks   ADD COLUMN IF NOT EXISTS auto_deliver BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE proactive_sources ADD COLUMN IF NOT EXISTS auto_deliver BOOLEAN NOT NULL DEFAULT true;
