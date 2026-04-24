# Benchmark and Regression Matrix

Every public value export and package subpath needs an automated owner. The source of truth is `scripts/coverage-matrix-test.ts`; this page explains the policy behind it.

## Policy

- Public API additions must be assigned to a coverage area in `scripts/coverage-matrix-test.ts`.
- Every coverage area must name at least one CI script. Larger or more variable measurements can also name local benchmark scripts or bench pages.
- CI scripts test correctness and stable invariants. Browser/network timing comparisons should report metrics by default and only fail on explicit gates.
- `benchmark-regression-test.ts` runs at the end of `check:all`, reads the latest JSON outputs from the preceding offline harnesses, and compares them to committed thresholds in `benchmarks/baselines/check-all-regression-baselines.json`.
- Network-heavy sweeps stay explicit. `bench:remote-loading` still emits self-checking JSON, but it is not part of default CI because cache-busted image runs spend real hosted bandwidth.
- Per-run JSON output belongs in `benchmarks/` and is ignored unless a run is worth archiving deliberately.

## Current Areas

| area | CI owner | local measurement surface |
|---|---|---|
| single image measurement and layout | `prepare-strategy-test.ts`, `stream-probe-test.ts` | `bench-probe-node.ts`, `/bench/probe.html`, `/bench/range-sizing.html`, `/bench/compare.html` |
| byte probing and format parsing | `parser-robustness-test.ts`, `parser-fuzz.ts`, `stream-probe-test.ts` | `probe-byte-threshold-corpus.ts`, `/bench/probe.html`, `/bench/range-sizing.html` |
| source analysis and measurement cache | `parser-robustness-test.ts`, `url-pattern-corpus.ts`, `prepare-strategy-test.ts` | `/bench/probe.html` |
| URL dimension parsers | `url-pattern-corpus.ts`, `prepare-strategy-test.ts` | corpus JSON output |
| orientation handling | `orientation-corpus.ts`, `prepare-strategy-test.ts` | corpus JSON output |
| object fitting | `fit-analysis-test.ts`, `pretext-integration-test.ts` | `/bench/compare.html` |
| prepare scheduling and decode cache | `prepare-queue-test.ts`, `decode-pool-test.ts` | `/bench/probe.html`, `/bench/range-sizing.html` |
| build-time manifest | `manifest-build-test.ts` | manifest JSON output |
| layout algebra | `packer-sweep.ts` | `/bench/packing.html`, `/bench/first-screen.html` |
| virtualized tile pool | `virtual-pool-test.ts`, `loading-gallery-test.ts` | `/bench/virtual-scroll.html`, virtual priority helpers |
| gallery loading orchestration | `loading-gallery-test.ts` | `remote-loading-strategy-bench.ts`, `bench:remote-loading`, `/bench/loading-pattern.html` |
| scroll prediction | `predict-test.ts` | `/bench/predict.html` |
| pretext integration | `pretext-integration-test.ts` | pretext demo consumers |

When a new code path represents a product choice, add both a cheap deterministic invariant and a measurement row. Example: a new image scheduling policy needs a fake-DOM order/cancellation test plus a remote browser sweep metric.
