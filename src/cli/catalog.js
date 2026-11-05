/**
 * Model metadata for the `codebuddy` route.
 *
 * Two sources answer two different questions, and keeping them apart is the
 * whole point of this module:
 *
 * - **Membership** ("which models may the picker offer?") comes from the CLI's
 *   own `--model` help text. The product manifest also lists models this
 *   account cannot call, so it cannot decide membership.
 * - **Metadata** ("what is this model called, how large is its context, which
 *   efforts does it take?") comes from the product manifest, because that is
 *   the only place those facts exist.
 *
 * Ids present in the membership list but absent from the manifest still get
 * advertised — with a readable name derived from the id — because the CLI
 * demonstrably accepts them.
 *
 * @module dsh-connect-codebuddy-cli/catalog
 */

/**
 * Effort tiers the plugin exposes, ascending by depth.
 *
 * The CLI accepts six (`--effort` help: minimal, low, medium, high, xhigh,
 * max), but the menu offers four. Measured on real turns, `minimal` and
 * `xhigh` add no depth the neighbouring tiers do not already cover, and every
 * model gets the same ladder so the picker never changes shape between them.
 */
const EFFORT_ORDER = ['low', 'medium', 'high', 'max']

/**
 * Human-readable effort labels, keyed by CLI effort id.
 *
 * DSH shows these in the reasoning-effort menu, so they are localized to the
 * GUI's Chinese default with the CLI's own English id retained in parentheses.
 */
const EFFORT_NAMES = {
  minimal: '最低 (minimal)',
  low: '低 (low)',
  medium: '中 (medium)',
  high: '高 (high)',
  xhigh: '很高 (xhigh)',
  max: '最高 (max)',
}

/**
 * Convert one model id into a display name when the manifest has no entry.
 *
 * `deepseek-v4-pro` becomes `Deepseek V4 Pro`, and an already-capitalized id
 * such as `GLM-5.3` keeps its own capitalization. This is a fallback only; the
 * manifest supplies the real names for every model it knows.
 * @param id - the CLI model id.
 * @returns a display name.
 */
function fallbackName(id) {
  return id
    .split(/[-_]+/u)
    .filter(part => part !== '')
    .map((part) => {
      // Keep ids that already carry their own casing (GLM, GPT) intact.
      if (/[A-Z]/u.test(part)) return part
      return part.charAt(0).toUpperCase() + part.slice(1)
    })
    .join(' ')
}

/**
 * Resolve the reasoning metadata for one model.
 *
 * Every model gets the same four-tier ladder, and the manifest is treated as
 * an optional hint rather than a gate. That is a deliberate reversal of the
 * first design, which only exposed efforts the manifest happened to declare.
 *
 * The reason is that `product.json` covers 7 of the 16 models the CLI advertises
 * in `--help`. Under the manifest-gated rule the other nine — including
 * `deepseek-v4-pro`, the strongest reasoning model in the catalog — showed no
 * effort menu at all, so their thinking depth could not be chosen. Probing the
 * CLI directly showed this was the wrong reading: `deepseek-v4-pro` answered a
 * reasoning prompt with 61 characters of thinking at `low` and 242 at `max`,
 * and `step-5-preview`, `minimax-m3.1-flash`, `minimax-m2.7`, `mimo-v2.6-pro`,
 * `kimi-k3.1-pro`, `kimi-k3-1` and `hy3-x` all responded the same way. The
 * absence of a manifest entry means "the vendor did not publish a ladder", not
 * "this model ignores `--effort`".
 *
 * The manifest is still consulted for one thing it genuinely knows: a model
 * that declares `supportsReasoning: false` does not think, so it gets no menu.
 * Its declared ladder also supplies the preselected default when it names one.
 * @param entry - manifest entry, or `undefined` when the model is unknown.
 * @returns DSH reasoning metadata, or `undefined` when the model takes no effort.
 */
function reasoningFor(entry) {
  if (entry?.supportsReasoning === false) return undefined
  const reasoning = entry?.reasoning ?? {}
  const ids = EFFORT_ORDER
  const declaredDefault = typeof reasoning.defaultEffort === 'string' && ids.includes(reasoning.defaultEffort)
    ? reasoning.defaultEffort
    : typeof reasoning.effort === 'string' && ids.includes(reasoning.effort)
      ? reasoning.effort
      : undefined
  return {
    efforts: ids.map(id => ({ id, name: EFFORT_NAMES[id] ?? id })),
    ...declaredDefault === undefined ? {} : { defaultEffort: declaredDefault },
  }
}

/**
 * Resolve the context window for one model.
 *
 * The manifest spells the window in several places, and they do **not** mean
 * the same thing. This deliberately mirrors the CLI's own
 * `resolveEffectiveContextBudget` precedence — `overrideContextWindow`,
 * then `contextWindow.defaultLength`, then `supportedLengths[0]`, then
 * `maxInputTokens` — because the denominator has to agree with the budget the
 * CLI actually auto-compacts against. A DSH-side window that disagrees with
 * the transport would make DSH compress on a different schedule than the
 * process that really owns the prompt, which is worse than being imprecise:
 * `glm-5.3` declares no `contextWindow` at all and runs on its 1M
 * `maxInputTokens`, so an "only explicit fields" rule would drop the meter
 * entirely for two thirds of the catalog.
 *
 * The first value in that precedence chain wins. `maxLength` is retained only
 * as a final compatibility fallback for older manifests; it is not mixed into
 * a minimum that would change the CLI's declared budget.
 * @param entry - manifest entry, or `undefined`.
 * @returns the context window, or `undefined` when the manifest declares none.
 */
function contextWindowFor(entry) {
  if (entry === undefined) return undefined
  const candidates = [
    entry.overrideContextWindow,
    entry.contextWindow?.defaultLength,
    entry.contextWindow?.supportedLengths?.[0],
    entry.maxInputTokens,
    entry.contextWindow?.maxLength,
  ]
  return candidates.find(value => typeof value === 'number' && Number.isFinite(value) && value > 0)
}

/**
 * Resolve the per-call output limit for one model.
 * @param entry - manifest entry, or `undefined`.
 * @returns the max output tokens, or `undefined` when undeclared.
 */
function defaultMaxTokensFor(entry) {
  const value = entry?.maxOutputTokens
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

/**
 * Resolve input modalities for one model.
 * @param entry - manifest entry, or `undefined`.
 * @returns `['text']` plus `'image'` when the model takes images.
 */
function inputModalitiesFor(entry) {
  return entry?.supportsImages === true ? ['text', 'image'] : ['text']
}

/**
 * Build the advertised model list.
 *
 * Each row is the full `modelInfoFor` answer rather than a hand-trimmed subset.
 * The picker reads `reasoning.efforts` and `context.contextWindow` straight off
 * these rows, so a field omitted here is invisible in the GUI no matter what
 * `resolveModel` would have said — that is exactly how the effort menu stayed
 * empty for every model while the adapter looked correct in isolation.
 * @param ids - model ids the CLI advertises, in CLI order.
 * @param manifest - `{ id → manifest entry }`.
 * @param provider - the owned route id.
 * @returns model metadata for every advertised id.
 */
export function availableModels(ids, manifest, provider) {
  return ids.map(id => modelInfoFor(provider, id, manifest))
}

/**
 * Build the exact metadata for one model.
 *
 * This answers for unadvertised ids too: DSH routing accepts ids outside the
 * advisory catalog, and refusing here would turn a routing choice into a
 * lookup error.
 * @param provider - the owned route id.
 * @param model - the CLI model id.
 * @param manifest - `{ id → manifest entry }`.
 * @returns resolved model metadata.
 */
export function modelInfoFor(provider, model, manifest) {
  const entry = manifest.get(model)
  const description = descriptionFor(entry)
  const contextWindow = contextWindowFor(entry)
  const defaultMaxTokens = defaultMaxTokensFor(entry)
  const reasoning = reasoningFor(entry)
  const credits = creditsFor(entry)
  const baseName = typeof entry?.name === 'string' && entry.name !== '' ? entry.name : fallbackName(model)
  return {
    provider,
    id: model,
    // The multiplier rides in the name because the model selector renders the
    // name and nothing else: the Host's catalog projection keeps only id, name,
    // description, and reasoning, so a dedicated field would never reach the
    // menu.
    name: credits === undefined ? baseName : `${baseName} · ${credits.label}`,
    ...credits === undefined ? {} : { credits },
    ...description === undefined ? {} : { description },
    inputModalities: inputModalitiesFor(entry),
    ...contextWindow === undefined ? {} : { context: { contextWindow } },
    ...defaultMaxTokens === undefined ? {} : { defaultMaxTokens },
    ...reasoning === undefined ? {} : { reasoning },
  }
}

/**
 * Read a model's credit multiplier from a product-manifest entry.
 *
 * Kept as the fallback path: the live catalog the CLI reports is preferred, and
 * this answers when that probe fails.
 * @param entry - manifest entry, or `undefined`.
 * @returns `{ ratio, label }`, or `undefined` when no multiplier is declared.
 */
export function creditsFor(entry) {
  return parseCreditLabel(entry?.credits)
}

/**
 * Parse a credit multiplier string.
 *
 * The CLI spells the same fact in two places — `"x0.79 credits"` in its product
 * manifest and in `_meta.credits` of the catalog its `/model` menu renders — so
 * one parser serves both and the two can never disagree about what a label
 * means.
 * @param raw - the raw multiplier text.
 * @returns `{ ratio, label }`, or `undefined` when it is not a multiplier.
 */
export function parseCreditLabel(raw) {
  if (typeof raw !== 'string') return undefined
  const match = /^[x×]\s*(\d+(?:\.\d+)?)/iu.exec(raw.trim())
  if (match === null) return undefined
  const ratio = Number.parseFloat(match[1])
  if (!Number.isFinite(ratio)) return undefined
  return { ratio, label: `×${match[1]}` }
}

/**
 * The localized one-line description shown under a model name.
 * @param entry - manifest entry, or `undefined`.
 * @returns the description, or `undefined` when the manifest has none.
 */
function descriptionFor(entry) {
  const zh = entry?.descriptionZh
  if (typeof zh === 'string' && zh !== '') return zh
  const en = entry?.descriptionEn
  return typeof en === 'string' && en !== '' ? en : undefined
}

/**
 * Map a DSH model id onto the id the CLI expects.
 *
 * The route advertises the CLI's own ids verbatim, so this is an identity
 * function today; it exists so a future decorated id (a namespaced or aliased
 * entry) has one place to translate.
 * @param model - the DSH-side model id.
 * @returns the CLI `--model` value.
 */
export function providerModelId(model) {
  return model
}

export { contextWindowFor, defaultMaxTokensFor, fallbackName, reasoningFor }
