# AGENTS

Sibling repo to [`@chenglou/pretext`](https://github.com/chenglou/pretext), [`@chenglou/vibescript`](https://github.com/chenglou/vibescript) and [`@chenglou/freerange`](https://github.com/chenglou/freerange). 

These repos may be found at `../best practices/' if running locally.

Same ecosystem, different concern: pretext owns text layout, vibescript owns UI conventions, preimage owns images, freerange owns verification. Read vibescript's AGENTS + `docs/` before working here — we follow its rules. Read the pretext and freerange READMEs.

`bun install` if you're in a fresh worktree.
`bun run check` for typecheck (we don't run tests — good TypeScript doesn't need them).
`bun run start` for the dev server at `http://localhost:3000`. Each demo is `/<name>.html`; benchmarks at `/bench/`.
`bun run build:demos` emits `dist-demos/` for GitHub Pages; deploy is a push to `main`.

Work on `main`. No feature branches, no PRs, no Claude Code commit signatures. Commit messages are imperative and short; the body explains the why. Version bumps go in `packages/<pkg>/CHANGELOG.md` under a new top entry — that's the only place users find "what changed."

`packages/preimage/` is the library; `packages/layout-algebra/` is its pure-math sibling. Public shape lives in each `CHANGELOG.md` top entry and each subpath export in `package.json`. `pages/demos/` are the canonical consumers — if a refactor breaks their shape, that's the shape breaking, not the demos. `pages/bench/` are measurement pages that save runs as JSON; commit those (not raw HARs — `scripts/distill-har.ts` distills first).

`DEVELOPMENT.md` has the longer form: running locally, the bench/distill workflow, how photos and the manifest are generated. Read it once before touching `scripts/` or the bench pages.

When you encounter a new code pattern that isn't documented here or in vibescript, or hesitate on structure, loudly alert **NEW PATTERN DETECTED**. Then write it into the relevant doc (probably vibescript's `docs/drafts/`, not here — preimage-specific lessons belong in the package CHANGELOG; generalizable ones go upstream). Docs are **generalizable** lessons, not one-offs.

**Important:** after finishing a feature with enough holistic context, do a pass over the files you touched and see if anything simplifies. Don't change things for the sake of. If there are real simplifications, YELL **I DID A HOLISTIC PASS AND FOUND SIMPLIFICATIONS** with a brief summary.

**Important:** do NOT monkey-patch. If you're solving a symptom instead of the root cause, reconsider and do a proper fix, then YELL **I SOLVED THE ROOT CAUSE NOT THE SYMPTOM** with a brief summary. Recent example: when `setPlacements` was forcing a layout flush per probe resolve, the fix was caching `scrollTop`/`clientHeight` in the pool, not adding a debounce around the call site.

## Style

Follow vibescript's tone rules in code, commits, and docs. Condensed:

- Concrete, archetypal examples over abstract shell nouns. `visibleRowRange` over `arr`; `scrollContainer` over `el`.
- One general rule + one concrete example, not a sermon. "Classes as full assignments, not toggles. E.g. `el.className = 'vtile has-image'` instead of `classList.add('has-image')` + `classList.remove('pending')` pairs that can drift."
- Don't invent universal rules from local lessons; don't treat local lessons as universal rules.
- Preserve the author's voice. Prefer slightly personal phrasing over generic explanatory filler.

## When in doubt

- The latest `CHANGELOG.md` top entries are the most up-to-date record of what's stable. Read them before reshaping a type.
- `pages/demos/virtual.ts` is the reference case for "async-streamed work + DOM recycling + rAF-batched render."
- `packages/layout-algebra/src/index.ts` is the reference case for pure-math, DOM-free style.
- Ask before introducing a dependency. Ask before refactoring across packages.
