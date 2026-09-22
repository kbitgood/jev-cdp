import { describe, expect, test } from "bun:test";

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
    expect(result.stdout).toBe("jev-cdp 0.1.3\n");
    expect(result.stderr).toBe("");
  });

  test("documents commands, output streams, and exit codes", () => {
    const result = runCli("help", "run");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Jev CDP 0.1.3 — run");
    expect(result.stdout).toContain("--fresh-context");
    expect(result.stdout).toContain("--field-value-env");
    expect(result.stdout).toContain("--interaction-pauses <ms>");
    expect(result.stdout).toContain("The final result is one JSON object on stdout.");
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
});
