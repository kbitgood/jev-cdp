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

Run the published CLI without adding it to a project. Bun must be installed for either command:

```bash
bunx jev-cdp@0.1.8 help run
npx -y jev-cdp@0.1.8 help run
```

Chrome with a CDP endpoint and `TYPESAFE_API_KEY` are required for browser runs. FFmpeg with H.264 encoding (`libx264`) is required for `--recording`. Jev selects `-fps_mode vfr` when FFmpeg supports it and falls back to `-vsync vfr` for older builds. Run `jev-cdp doctor` to check the installed encoder with a short MP4 encode and decode.

For source development:

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

`--recording` captures Chrome's compositor screencast stream for the full goal and renders a 1280×720 H.264 MP4. A 40-pixel browser bar shows the active tab's URL above the page. Chrome uses a 1506×800 viewport, scaled to fit the video beneath the bar, so controls remain at their observed coordinates while more of the page fits on screen. Because Chrome's native pointer is not part of the stream, the adapter draws a high-contrast cursor that starts at the viewport center, glides to each target, and pulses on clicks. `--interaction-pauses` adds a deterministic delay after opening or loading a page, changing the URL within a page, or moving to a click target before pressing the mouse. Jev chooses during page pauses, and the adapter waits only for any time left before acting. Jev does not choose or observe those delays. When an action opens a new tab, the recording shows a "New tab opened" notice over the previous tab for the full configured pause, then switches to the new tab. With zero pause, the notice appears for one frame without delaying Jev. `--screenshot` saves a 1280×720 image with the same browser bar, even when recording is off. If a new tab opened, the final screenshot also includes the notice.

`jev-cdp run` writes JSON Lines to standard output: one `type:"action"` object per executed action, followed by one `type:"result"` object with the final status and action budget. Action objects include elapsed execution time, the operation, page and tab URLs, the viewport, and a CSS selector, role, name, frame, and coordinates for the element. Fill actions include the entered text; password fields and `--field-value-env` values are redacted and must be supplied separately for replay. Select and scroll actions include their option value or wheel delta. The CSS selector and page URL can be used as Playwright replay targets, with the coordinates as a fallback at the recorded viewport size. `--final-state` adds the final semantic page snapshot: a frame tree with URLs and loading state, actionable elements with frame identity, screen bounds, nearby text, region, clickability, and any element covering the click point, plus new-tab and redirect transitions. Automatic navigation and embedded-content waits use `--wait-budget-ms` (15 seconds by default) and do not consume `--max-steps`; a timeout returns `wait_timeout`, its pending condition and elapsed wait time, and the latest semantic state. Runtime failures emit a `type:"result"` object with `status:"error"`; diagnostic text uses standard error.

Each action object includes `consoleErrors` observed during that step. The result object includes `initialConsoleErrors` already present when attaching to the tab and `consoleErrors` for the full run. These fields include browser console errors, uncaught exceptions, and error-level DevTools log entries from the page and its frames. Review them alongside the semantic state; a console error does not by itself establish that the goal failed.

The snapshot includes visible controls in nested iframes, including cross-origin frames. Clicking a link there uses its frame coordinates and checks that the observed control is still current. If that click opens a new tab, Jev switches to it, returns its target ID for the next goal, and keeps the 1506×800 viewport consistent across the switch.

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
| `--recording PATH.mp4` | — | off | Record a 1280×720 video with a URL bar, animated cursor, and tab notices |
| `--interaction-pauses MS` | — | `0` | Pause after page loads and before clicks, overlapping page pauses with Jev decisions |
| `--screenshot PATH.jpg` | — | off | Save a 1280×720 image with the URL bar and any new-tab notice |
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
