import { useEffect } from 'react';
import { wsClient } from '../lib/ws';

/**
 * Émet le signal de présence `session.viewing` pour la session chat ouverte.
 *
 * viewing=true quand l'onglet est VISIBLE et la fenêtre FOCUS (l'utilisateur a réellement la
 * conversation sous les yeux) ; viewing=false sinon (onglet caché, fenêtre en arrière-plan)
 * et au démontage / changement de session. Distinct de l'abonnement WS (`session.subscribe`,
 * géré par useChat) : c'est CE signal qui pilote la presence dedup du push côté backend
 * (ws.ts hasSessionViewers). Sans lui, un onglet laissé ouvert en fond supprimait le réveil
 * mobile (cf. bug de livraison du briefing). En cas de doute on n'émet PAS viewing (fail-safe :
 * mieux vaut un push de trop qu'un réveil manqué).
 */
export function useSessionViewing(sessionId: string | null): void {
  useEffect(() => {
    if (!sessionId) return;

    let current = false;
    const isViewing = () => document.visibilityState === 'visible' && document.hasFocus();
    const emit = (viewing: boolean) => {
      if (viewing === current) return;
      current = viewing;
      wsClient.send({ type: 'session.viewing', sessionId, viewing });
    };
    const update = () => emit(isViewing());

    update(); // état initial à l'ouverture de la session
    document.addEventListener('visibilitychange', update);
    window.addEventListener('focus', update);
    window.addEventListener('blur', update);

    return () => {
      document.removeEventListener('visibilitychange', update);
      window.removeEventListener('focus', update);
      window.removeEventListener('blur', update);
      // Quitte la session (changement de session ou démontage de la vue chat) → plus regardée.
      if (current) wsClient.send({ type: 'session.viewing', sessionId, viewing: false });
    };
  }, [sessionId]);
}
