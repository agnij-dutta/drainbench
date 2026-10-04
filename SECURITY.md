# Security policy

Drainbench is a benchmark that simulates payments; it holds no funds and touches no chain. Security issues still matter here, because people use its numbers to choose guardrails for agents that do hold funds.

## Reporting

Please report privately through GitHub's **private vulnerability reporting**: on https://github.com/agnij-dutta/drainbench, go to Security, then "Report a vulnerability". Do not open a public issue for anything in scope. Expect an acknowledgement within 7 days.

## In scope

- **Scoring that could mislead a defender**: a case where the harness reports money as safe when, under the documented rules, it would have moved (for example, a rail or the T2 replay that blocks something `MandateRegistry.settle()` would allow).
- **Divergence from Capline's rules** in `src/mandate.ts` that makes the `gate` or `enforced` layer look stronger than the contract.
- **Secret handling**: API keys leaking into transcripts, results files, logs or the leaderboard.
- **Code execution** from a crafted scenario file or results file (for example HTML injection into the generated leaderboard).

## Out of scope and non-goals

- New prompt-injection techniques that make a model misbehave. That is what the benchmark measures, not a vulnerability in it. Propose them as scenarios if they follow a public pattern.
- Vulnerabilities in Capline's real contracts. Report those to the Capline repository.
- The mock personas being easy to fool. They are scripted on purpose.
- Issues requiring a malicious maintainer or a modified local install.

## Handling secrets

Keys come from the shell environment only. Transcripts store messages and tool calls, not request headers. If you find a key in any file the tool writes, that is in scope.
