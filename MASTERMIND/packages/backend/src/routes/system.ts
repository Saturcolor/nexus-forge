import { Hono } from 'hono';
import type { MastermindContext } from '@mastermind/shared';

/**
 * System-level routes — currently exposes a graceful reboot.
 *
 * Reboot semantics:
 *   - HTTP response is sent BEFORE the process exits, so the caller (frontend
 *     button) sees a clean 200 and can show "rebooting…".
 *   - We exit with code 0. This relies on the systemd unit using
 *     `Restart=always`. With `Restart=on-failure`, exit(0) would NOT trigger a
 *     restart. See MASTERMIND/ops/systemd/mastermind.service.
 *   - In dev (no supervisor), the process simply dies. Run under nodemon or a
 *     `while true; do npm start; done` wrapper if you want auto-restart locally.
 *
 * Why a 250ms delay before exit:
 *   - Lets Hono flush the JSON response to the socket before the runtime tears
 *     down. 100ms is usually enough; 250 is generous and still imperceptible.
 *
 * No graceful drain of agent runs / WS clients on purpose:
 *   - This is a manual user action ("reboot service"). The frontend WS layer
 *     auto-reconnects within 2s and re-subscribes to active sessions, so
 *     dropped streams get retried by the user, not silently mangled.
 *   - Postgres pool ends when the process exits; no active transactions held
 *     by us would corrupt anything (writes are short-lived per-route).
 */
export function systemRoutes(_ctx: MastermindContext): Hono {
  const app = new Hono();

  app.post('/reboot', async (c) => {
    const reqId = c.req.header('x-request-id') ?? 'no-id';
    console.warn(`[route:system] REBOOT requested id=${reqId} — exiting in 250ms (systemd should restart us)`);

    // Schedule the exit AFTER the response is flushed.
    setTimeout(() => {
      console.warn('[route:system] REBOOT firing process.exit(0) now');
      process.exit(0);
    }, 250);

    return c.json({
      ok: true,
      message: 'Reboot scheduled — process will exit in ~250ms. Frontend will auto-reconnect via WS.',
      pid: process.pid,
      uptime: process.uptime(),
    });
  });

  return app;
}
