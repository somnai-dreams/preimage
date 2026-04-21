// Pretext-integration barrel. Requires `@chenglou/pretext` as a peer
// dependency at runtime; the types imported here come from that package.

export {
  solveFloat,
  flowColumnWithFloats,
  measureColumnFlow,
  type FloatSpec,
  type FloatSide,
  type PlacedFloat,
  type PlacedLine,
  type ColumnFlowItem,
  type ColumnFlowOptions,
  type ColumnFlowResult,
} from './pretext-float.js'

export {
  inlineImage,
  inlineImageItem,
  resolveMixedInlineItems,
  isInlineImageItem,
  PREIMAGE_INLINE_MARKER,
  type InlineImageItem,
  type InlineImageOptions,
  type MixedInlineItem,
} from './pretext-inline.js'
