/**
 * Review of the recheck fixes (2026-09-28): the server SDK must never record an
 * incoming request body.
 *
 * `@sentry/nextjs` installs Node's HTTP integration with the body size left at its
 * default, 'medium' (10 KB), and that default applies whatever `sendDefaultPii`
 * says. Next reads a server action's multipart body through the listener the SDK
 * patches, so the whole body was kept on the request's scope and copied into
 * `event.request.data` of any error that request reported. For the sign-in form
 * that is the username and a password that had just been verified: an unguarded
 * query after `signIn()` that times out reports the action's error, body and all.
 * The scrubber could not help: it looks for phone numbers and e-mail addresses,
 * and a password is neither.
 *
 * So the body is never read. `lib/sentry-scrub.ts` also drops `request.data` from
 * every event on every runtime, as the second line; this is the first.
 *
 * One function, used by `sentry.server.config.ts` and by
 * `tests/unit/sentry-envelope.test.ts`, so the envelope test runs exactly the
 * integration production runs. It replaces the SDK's default of the same name,
 * so it passes on the one option that default sets.
 */
import * as Sentry from '@sentry/nextjs';

export function serverIntegrations() {
  return [
    Sentry.httpIntegration({
      // What @sentry/nextjs's own default passes: Next makes the request spans itself.
      disableIncomingRequestSpans: true,
      maxIncomingRequestBodySize: 'none',
    }),
  ];
}
