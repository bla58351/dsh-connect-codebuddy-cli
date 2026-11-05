/**
 * Hand the attachment service to the adapter so user images can be read.
 *
 * Extracted from the plugin entry so the entry stays wiring only; no
 * behaviour changed in the move.
 * @module dsh-connect-codebuddy-cli/host/attachments
 */

/**
 * Hand the adapter the Host attachment service, which owns image bytes.
 *
 * DSH gives an image-capable adapter a durable reference, not pixels, so a turn
 * has to ask this service for a request-sized variant. A composition without it
 * simply forwards text, which is what happened before images were supported at
 * all.
 *
 * @param ctx - the plugin context.
 * @param adapter - the provider adapter.
 */
function installAttachments(ctx, adapter) {
  if (typeof ctx.inject !== 'function') return
  ctx.inject(['attachments'], (inner) => {
    const attachments = typeof inner.get === 'function' ? inner.get('attachments') : inner.attachments
    if (attachments !== undefined && attachments !== null) adapter.attachAttachments(attachments)
  })
}

export {
  installAttachments,
}
