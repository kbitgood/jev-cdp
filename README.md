# Jev Browser Use

A Bun and TypeScript port of [Browser Use's `jev-ultrafast`](https://github.com/browser-use/jev-ultrafast). Jev chooses one browser operation and one observed target at a time. An authenticated Codex CLI running `gpt-5.6-luna` generates text only when Jev selects a text field.

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
  --user-data-dir=/tmp/jev-browser-use-chrome
```

## Run the todo smoke test

With the todo fixture available at `http://127.0.0.1:4173`:

```bash
TYPESAFE_API_KEY="$(security find-generic-password -a "$USER" -s 'ai.typesafe.api-key' -w)" \
bun run run -- \
  --url http://127.0.0.1:4173 \
  --goal 'Add a todo as if you are Han Solo. Mark that same todo as completed, then show only completed todos. Finish when the completed item is visible.' \
  --max-steps 12 \
  --visible \
  --keep-open
```

The CLI exits with code `0` only when Jev reports `DONE`. `BLOCKED` and step-budget exhaustion use nonzero exit codes and leave a structured summary in the terminal.

## Use an already-open Chrome tab

List the controllable page targets:

```bash
bun run run -- --list-tabs
```

Then attach to one exact target without navigating it:

```bash
TYPESAFE_API_KEY="$(security find-generic-password -a "$USER" -s 'ai.typesafe.api-key' -w)" \
bun run run -- \
  --tab TARGET_ID_FROM_LIST \
  --goal 'Complete all the todos and show the completed list.' \
  --max-steps 12 \
  --visible
```

An attached tab is never closed by the runner. Add `--url` only when you intentionally want to navigate that selected tab before the run.

## Configuration

| CLI | Environment | Default | Purpose |
| --- | --- | --- | --- |
| `--max-steps N` | `JEV_MAX_STEPS` | `12` | Maximum executed browser actions |
| `--visible` | `JEV_BROWSER_VISIBLE=1` | off | Activate the controlled Chrome tab |
| `--keep-open` | `JEV_BROWSER_KEEP_OPEN=1` | off | Leave the controlled tab open after the run |
| `--cdp URL` | `CHROME_CDP_URL` | `http://127.0.0.1:9222` | Chrome DevTools HTTP endpoint |
| `--tab TARGET_ID` | — | create a new tab | Attach to one exact existing Chrome page target |
| `--list-tabs` | — | — | Print target IDs, titles, and URLs for open page tabs |

## Development

```bash
bun run check
```

No browser or paid API is required by the unit tests.
