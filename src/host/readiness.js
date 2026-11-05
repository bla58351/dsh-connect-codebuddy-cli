/**
 * Explain why the route cannot serve yet, in words the page can render.
 *
 * The implementation lives in `account/readiness.js` so the adapter's
 * pre-flight check can use it without depending on the host layer (the
 * layering runs `host/ → adapter/` only). This module stays as the host-side
 * import point; the public export from the package root is unchanged.
 * @module dsh-connect-codebuddy-cli/host/readiness
 */

export { describeReadiness } from '../account/readiness.js'
