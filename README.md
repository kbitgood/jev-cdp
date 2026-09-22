# Jev CDP

Jev CDP is a small Jev-powered bridge to Chrome through the Chrome DevTools Protocol (CDP). The deliberately narrow name describes what this project owns: it connects Jev's typed browser decisions to a Chrome CDP session. It is not intended to be a general browser-use framework or an official Jev client.

It is a Bun and TypeScript port of [Browser Use's `jev-ultrafast`](https://github.com/browser-use/jev-ultrafast). Jev chooses one browser operation and one observed target at a time. An authenticated Codex CLI running `gpt-5.6-luna` generates text only when Jev selects a text field.

This is an early experimental port. See [NOTICE.md](NOTICE.md) for source attribution and the exact upstream revision.

## What is preserved

- One TypeSafe request per decision cycle, with speculative target heads.
- Model choices are limited to operations and indexed elements observed by code.
- Actual DOM nodes are retained in the page and checked again before input.
- Text generation is isolated from browser execution and must return `{ "text": string }`.
- A stale decision cannot execute against a changed page.
- Every run has a configurable maximum browser-step budget.

## Requirements

- [Bun](https://bun.sh/)
- Google Chrome running with a local CDP endpoint
- A TypeSafe API key
- An authenticated Codex CLI for the default Luna text helper

## Setup

```bash
bun install
cp .env.example .env
```

Keep `TYPESAFE_API_KEY` out of `.env` when possible. On macOS, inject it from Keychain when launching the runner.

Start an isolated Chrome instance:

```bash
open -na "Google Chrome" --args \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/jev-cdp-chrome
```

Check the complete local setup:

```bash
TYPESAFE_API_KEY="$(security find-generic-password -a "$USER" -s 'ai.typesafe.api-key' -w)" \
bun run run -- doctor
```

Explore the CLI without credentials or a browser connection:

```bash
bun run run -- --help
bun run run -- help run
bun run run -- --version
```

## Run the verified todo scenario

The repository includes and serves its own isolated todo fixture. This command runs three fresh scenarios, verifies each stage in code, runs a separate two-step budget-stop check, and writes screenshots, JSON traces, and MP4 recordings under the ignored `artifacts/` directory:

```bash
TYPESAFE_API_KEY="$(security find-generic-password -a "$USER" -s 'ai.typesafe.api-key' -w)" \
bun run scenario:todo -- --runs 3 --max-steps 6 --guard-steps 2 --visible
```

The scenario deliberately uses small, literal goals: add one item, click its completion control, then click the Completed filter. Deterministic page-state checks stop each successful stage before Jev can repeat it. If Jev incorrectly reports `DONE`, the orchestrator rejects that claim and can retry the attached tab with a more explicit bounded goal. The scenario exits with code `0` only when every clean-run assertion passes and the guard run stops exactly at its configured action budget.

FFmpeg must be on `PATH` to render the recordings. The Codex subscription helper reports latency and model identity, but its CLI integration does not expose token usage.

## Run one ad hoc goal

The lower-level CLI exits with code `0` only when Jev reports `DONE`. `BLOCKED` and step-budget exhaustion use nonzero exit codes and leave a structured summary in the terminal.

```bash
TYPESAFE_API_KEY="$(security find-generic-password -a "$USER" -s 'ai.typesafe.api-key' -w)" \
bun run run -- run \
  --url https://example.com \
  --goal 'Open the More information link.' \
  --max-steps 4 \
  --visible \
  --keep-open \
  --interaction-pauses 500 \
  --recording artifacts/example/run.mp4 \
  --screenshot artifacts/example/final.jpg \
  --final-state
```

`--recording` captures Chrome's compositor screencast stream for the full goal and renders an H.264 MP4. Because Chrome's native pointer is not part of that stream, the adapter draws a high-contrast cursor that starts at the viewport center, glides to each target, and pulses on clicks. `--interaction-pauses` adds a deterministic delay in milliseconds after moving to a click target and before pressing the mouse; Jev does not choose or observe this delay. `--screenshot` saves the final viewport after the goal stops; when recording is also enabled, it reuses the final screencast frame.

`--final-state` adds an AI-oriented semantic snapshot to the final JSON on standard output. It includes the final URL, title, visible text, viewport, scroll state, actionable elements, accessible labels, and control state such as `pressed`, `checked`, `selected`, and `expanded`. Progress remains on standard error, so a coding agent can parse standard output as one JSON object and choose the next bounded goal without another browser observation.

## Supply known field values without another LLM

For portable QA scenarios, let the planner provide exact test data instead of invoking the Luna fallback. Match a field by its observed accessible label:

```bash
TYPESAFE_API_KEY="$(security find-generic-password -a "$USER" -s 'ai.typesafe.api-key' -w)" \
bun run run -- run \
  --url http://127.0.0.1:4173 \
  --goal 'Add exactly one todo named Dodge. Finish when it is visible.' \
  --field-value 'New todo=Dodge' \
  --max-steps 4 \
  --keep-open \
  --final-state
```

The exact value is typed with zero text-helper latency. If no matching `--field-value` is supplied, the configured Luna or API helper remains the fallback. Keep repeated work as separate verified goals: add one named item, verify it, then continue on the returned `targetId`. This avoids a compound goal repeatedly filling the same field.

For passwords or other secrets, pass the name of an existing environment variable so the value does not appear in the process arguments:

```bash
bun run run -- run \
  --url https://example.test/login \
  --goal 'Log in with the caller-provided Username and Password.' \
  --field-value 'Username=Admin' \
  --field-value-env 'Password=TEST_LOGIN_PASSWORD' \
  --max-steps 6 \
  --final-state
```

Password controls are exposed to Jev as writable fields, but their values are represented only as empty or `[set]`. Sensitive values are redacted from semantic state, model requests, action history, and text-call records. If Jev selects a sensitive field without a caller-provided value, execution stops instead of asking the text helper to invent one.

## Use an already-open Chrome tab

List the controllable page targets:

```bash
bun run run -- tabs
```

Then attach to one exact target without navigating it:

```bash
TYPESAFE_API_KEY="$(security find-generic-password -a "$USER" -s 'ai.typesafe.api-key' -w)" \
bun run run -- run \
  --tab TARGET_ID_FROM_LIST \
  --goal 'Complete all the todos and show the completed list.' \
  --max-steps 12 \
  --visible
```

An attached tab is never closed by the runner. Add `--url` only when you intentionally want to navigate that selected tab before the run.

## Use a fresh browser context

Omitting `--tab` creates a new tab in Chrome's existing default context, so it shares that profile's cookies and local storage. Add `--fresh-context` when the run needs a clean, isolated session:

```bash
TYPESAFE_API_KEY="$(security find-generic-password -a "$USER" -s 'ai.typesafe.api-key' -w)" \
bun run run -- run \
  --fresh-context \
  --url https://example.test/login \
  --goal 'Inspect the logged-out page and finish.' \
  --max-steps 2 \
  --visible \
  --final-state
```

The context is disposed after evidence capture by default. Combine it with `--keep-open` to retain the isolated window and use the returned `targetId` in later runs. `--fresh-context` cannot be combined with `--tab`.

## Configuration

| CLI | Environment | Default | Purpose |
| --- | --- | --- | --- |
| `--max-steps N` | `JEV_MAX_STEPS` | `12` | Maximum executed browser actions |
| `--visible` | `JEV_BROWSER_VISIBLE=1` | off | Activate the controlled Chrome tab |
| `--keep-open` | `JEV_BROWSER_KEEP_OPEN=1` | off | Leave the controlled tab open after the run |
| `--fresh-context` | `JEV_BROWSER_FRESH_CONTEXT=1` | off | Create an isolated context with fresh cookies and storage |
| `--cdp URL` | `CHROME_CDP_URL` | `http://127.0.0.1:9222` | Chrome DevTools HTTP endpoint |
| `--tab TARGET_ID` | — | create a new tab | Attach to one exact existing Chrome page target |
| `tabs` | — | — | Print target IDs, titles, and URLs for open page tabs |
| `--recording PATH.mp4` | — | off | Record the complete goal with an animated cursor |
| `--interaction-pauses MS` | — | `0` | Wait after moving to a click target, before mousedown |
| `--screenshot PATH.jpg` | — | off | Save the final browser viewport |
| `--final-state` | — | off | Include the final semantic page state in stdout JSON |
| `--field-value LABEL=VALUE` | — | Luna fallback | Type caller-provided test data into the exactly labeled field |
| `--field-value-env LABEL=NAME` | — | off | Read a sensitive field value from an environment variable |

## Development

```bash
bun run check
bun run build
./dist/jev-cdp --help
```

`bun run build` produces a standalone executable for the current operating system and architecture. Chrome remains an external runtime dependency, and FFmpeg remains optional unless recording is requested. No browser or paid API is required by the unit tests.
