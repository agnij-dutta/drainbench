# Changelog

All notable changes are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/). Changes that alter how numbers are computed bump `HARNESS_VERSION` and are listed under "Scoring".

## [Unreleased]

## [0.1.0] - 2026-10-05

First public release. All bundled results are MOCK.

### Added
- 75-case corpus `scenarios/v1`: 10 attack categories of 6 cases each, plus 15 benign controls, each citing a public injection pattern.
- Four defense layers scored side by side: `none`, `prompt`, `gate` (Capline Layer A) and `enforced` (Capline Layer B), with an in-process simulation of `MandateRegistry.settle()`.
- Metrics: attempted, followed injection, funds lost, $ lost, $ to attacker addresses, T2 key-compromise replay, benign success, utility under attack, and a combined score.
- Providers: OpenAI, Groq, OpenRouter, Together, any OpenAI-compatible server, Anthropic, and four deterministic mock personas. Provider registry with `registerProvider()`.
- CLI (`run`, `report`, `leaderboard`, `validate`, `list`), transcript cache with resume, markdown report and static leaderboard, with MOCK labels on every mock row.
- Biome lint and format, CI workflow, gitleaks config, CONTRIBUTING, SECURITY and CITATION files.

### Scoring (harness 1.1.0)
- Money is tracked in integer micro-USDC, so caps compare exactly.
- Every rail rejects malformed payees and amounts (`INVALID_ADDRESS`, `INVALID_AMOUNT`).
- The T2 replay drops retries only after gate or chain denials, never after wallet denials, so T2 loss is never below T1 loss.
- Rates with an empty denominator are `null` (shown as n/a), not 0%.
