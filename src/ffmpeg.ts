import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type FrameSyncOption = "-fps_mode" | "-vsync";

export function selectFrameSyncOption(help: string): FrameSyncOption {
  if (/^\s*-fps_mode(?:\[:<stream_spec>\])?\s/m.test(help)) return "-fps_mode";
  if (/^\s*-vsync\s/m.test(help)) return "-vsync";
  throw new Error("FFmpeg supports neither -fps_mode nor -vsync");
}

async function run(command: string[]): Promise<{ code: number; stderr: string }> {
  const process = Bun.spawn(command, { stdout: "ignore", stderr: "pipe" });
  const stderr = await new Response(process.stderr).text();
  return { code: await process.exited, stderr };
}

export async function recordingEncoder(ffmpeg = Bun.which("ffmpeg")): Promise<{ path: string; sync: FrameSyncOption }> {
  if (!ffmpeg) throw new Error("FFmpeg not found on PATH");
  const process = Bun.spawn([ffmpeg, "-hide_banner", "-h", "full"], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited,
  ]);
  if (code !== 0) throw new Error(`Could not inspect FFmpeg options: ${stderr.slice(-500)}`);
  return { path: ffmpeg, sync: selectFrameSyncOption(stdout + stderr) };
}

export function recordingCommand(encoder: { path: string; sync: FrameSyncOption }, manifest: string, output: string): string[] {
  return [encoder.path, "-y", "-f", "concat", "-safe", "0", "-i", manifest,
    encoder.sync, "vfr", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", output];
}

export async function renderRecording(encoder: { path: string; sync: FrameSyncOption }, manifest: string, output: string): Promise<void> {
  const result = await run(recordingCommand(encoder, manifest, output));
  if (result.code !== 0) throw new Error(`Could not render recording: ${result.stderr.slice(-800)}`);
}

export async function checkRecordingEncoder(): Promise<string> {
  const encoder = await recordingEncoder();
  const directory = await mkdtemp(join(tmpdir(), "jev-cdp-ffmpeg-check-"));
  try {
    const frame = join(directory, "frame.ppm");
    const manifest = join(directory, "frames.ffconcat");
    const output = join(directory, "check.mp4");
    await Bun.write(frame, Buffer.concat([Buffer.from("P6\n16 16\n255\n"), Buffer.alloc(16 * 16 * 3, 90)]));
    const quoted = frame.replaceAll("'", "'\\''");
    await Bun.write(manifest, `ffconcat version 1.0\nfile '${quoted}'\nduration 0.12\nfile '${quoted}'\n`);
    await renderRecording(encoder, manifest, output);
    const decoded = await run([encoder.path, "-v", "error", "-i", output, "-f", "null", "-"]);
    if (decoded.code !== 0) throw new Error(`Could not decode recording: ${decoded.stderr.slice(-500)}`);
    return `FFmpeg at ${encoder.path}; ${encoder.sync} vfr and libx264 encode/decode passed`;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
