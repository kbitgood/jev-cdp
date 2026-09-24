import { describe, expect, test } from "bun:test";
import { actionEvent } from "../src/cli";
import { redactConsoleErrors } from "../src/agent";
import type { HistoryEntry } from "../src/types";

function runCli(...args: string[]) {
  const result = Bun.spawnSync([Bun.which("bun")!, "src/cli.ts", ...args], {
    cwd: import.meta.dir.replace(/\/test$/, ""),
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

describe("CLI metadata and help", () => {
  test("prints the package version", () => {
    const result = runCli("--version");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("jev-cdp 0.1.8\n");
    expect(result.stderr).toBe("");
  });

  test("documents commands, output streams, and exit codes", () => {
    const result = runCli("help", "run");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Jev CDP 0.1.8 — run");
    expect(result.stdout).toContain("--fresh-context");
    expect(result.stdout).toContain("--field-value-env");
    expect(result.stdout).toContain("--interaction-pauses <ms>");
    expect(result.stdout).toContain("--wait-budget-ms <number>");
    expect(result.stdout).toContain("Stdout is JSON Lines: one object per executed action, then one result object.");
    expect(result.stdout).toContain("3  The maximum browser-step budget was exhausted.");
    expect(result.stderr).toBe("");
  });

  test("keeps the legacy flag-only run syntax and validates it", () => {
    const result = runCli("--url", "https://example.com");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--goal is required");
    expect(result.stderr).toContain("jev-cdp --help");
  });

  test("rejects invalid interaction pause durations before starting a browser", () => {
    for (const value of ["-1", "1.5", "abc", "9007199254740992"]) {
      const result = runCli("run", "--url", "https://example.com", "--goal", "Click", "--interaction-pauses", value);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("--interaction-pauses must be a non-negative integer in milliseconds");
    }
  });

  test("rejects invalid wait budgets before starting a browser", () => {
    for (const value of ["0", "-1", "1.5", "abc"]) {
      const result = runCli("run", "--url", "https://example.com", "--goal", "Click", "--wait-budget-ms", value);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("--wait-budget-ms must be a positive integer");
    }
  });
});

test("action JSON includes a replay target, entered text, timing, and budget without model latency", () => {
  const entry = {
    step: 2, kind: "fill", action: "Search", executed_ms: 840, text: "reserved domains",
    redacted: false, element: { css: "#search", role: "textbox", name: "Search", tag: "input",
      href: null, inputType: "search", point: { x: 80, y: 40 }, frame: null },
    from_url: "https://example.test/", url: "https://example.test/results",
    viewport: { width: 1120, height: 780 },
    from_target_id: "tab-1", target_id: "tab-1", page_changed: true,
    consoleErrors: [{ source: "console", message: "Failed to load", targetId: "tab-1" }],
  } as HistoryEntry;
  expect(actionEvent(entry, 5)).toEqual({
    type: "action", status: "executed", step: 2, elapsedMs: 840,
    budget: { used: 2, max: 5, remaining: 3 },
    page: { before: "https://example.test/", after: "https://example.test/results", changed: true,
      viewport: { width: 1120, height: 780 } },
    tab: { before: "tab-1", after: "tab-1" },
    consoleErrors: entry.consoleErrors,
    action: { kind: "fill", label: "Search", element: entry.element, text: "reserved domains", redacted: false },
  });
});

test("console error output redacts caller-provided secret values", () => {
  expect(redactConsoleErrors([{ source: "console", message: "Token abc123 failed", url: "https://example.test/abc123", targetId: "tab-1" }], ["abc123"]))
    .toEqual([{ source: "console", message: "Token [redacted] failed", url: "https://example.test/[redacted]", targetId: "tab-1" }]);
});
