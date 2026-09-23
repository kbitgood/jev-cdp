import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkRecordingEncoder, recordingCommand, recordingEncoder, renderRecording, selectFrameSyncOption } from "../src/ffmpeg";

test("selects the supported frame timing option by capability", () => {
  expect(selectFrameSyncOption("  -vsync <>  legacy\n  -fps_mode[:<stream_spec>]  current\n")).toBe("-fps_mode");
  expect(selectFrameSyncOption("  -vsync <>  legacy\n")).toBe("-vsync");
  expect(() => selectFrameSyncOption("unrelated option")).toThrow("neither -fps_mode nor -vsync");
  expect(recordingCommand({ path: "ffmpeg", sync: "-fps_mode" }, "frames.ffconcat", "out.mp4"))
    .toContain("-fps_mode");
  expect(recordingCommand({ path: "ffmpeg", sync: "-vsync" }, "frames.ffconcat", "out.mp4"))
    .toContain("-vsync");
});

test("records a short variable-timing H.264 MP4 and decodes it", async () => {
  if (!Bun.which("ffmpeg")) return;
  const encoder = await recordingEncoder();
  await checkRecordingEncoder();
  const directory = await mkdtemp(join(tmpdir(), "jev-cdp-recording-test-"));
  try {
    const paths = [join(directory, "a.ppm"), join(directory, "b.ppm")];
    await Promise.all(paths.map((path, index) => Bun.write(path,
      Buffer.concat([Buffer.from("P6\n16 16\n255\n"), Buffer.alloc(16 * 16 * 3, index ? 200 : 40)]))));
    const manifest = join(directory, "frames.ffconcat");
    const output = join(directory, "recording.mp4");
    await Bun.write(manifest, `ffconcat version 1.0\nfile '${paths[0]}'\nduration 0.04\nfile '${paths[1]}'\nduration 0.20\nfile '${paths[1]}'\n`);
    await renderRecording(encoder, manifest, output);
    const decoded = Bun.spawnSync([encoder.path, "-v", "error", "-i", output, "-f", "null", "-"], { stdout: "pipe", stderr: "pipe" });
    expect(decoded.exitCode).toBe(0);
    expect(decoded.stderr.toString()).toBe("");
    const probe = Bun.which("ffprobe");
    if (probe) {
      const metadata = Bun.spawnSync([probe, "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name", "-show_entries", "frame=best_effort_timestamp_time", "-of", "json", output], { stdout: "pipe", stderr: "pipe" });
      expect(metadata.exitCode).toBe(0);
      const video = JSON.parse(metadata.stdout.toString()) as { streams: { codec_name: string }[]; frames: { best_effort_timestamp_time: string }[] };
      expect(video.streams[0]?.codec_name).toBe("h264");
      expect(video.frames.length).toBeGreaterThanOrEqual(2);
      const gaps = video.frames.slice(1).map((frame, index) => Number(frame.best_effort_timestamp_time) - Number(video.frames[index]!.best_effort_timestamp_time));
      expect(Math.max(...gaps)).toBeGreaterThan(Math.min(...gaps));
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
