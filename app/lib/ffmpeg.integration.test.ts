import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { useMediaFixture } from "../test-fixtures/media";
import {
  decodeAudioPcm,
  extractAudio,
  extractThumbnails,
  ffprobe,
  transcodeAudio,
  transcodeVideo,
} from "./ffmpeg";
import { tempDir } from "./temp-dir";

const getMedia = useMediaFixture();

describe("ffprobe", () => {
  it("returns video and audio streams for a normal mp4", async () => {
    const probe = await ffprobe(getMedia().videoMp4);
    expect(probe.videoStream).not.toBeNull();
    expect(probe.audioStream).not.toBeNull();
    expect(probe.videoStream?.codec).toBe("h264");
    expect(probe.videoStream?.width).toBe(320);
    expect(probe.videoStream?.height).toBe(240);
    expect(probe.audioStream?.codec).toBe("aac");
    expect(probe.durationSec).toBeGreaterThan(10);
    expect(probe.durationSec).toBeLessThan(12);
    expect(probe.sizeBytes).toBeGreaterThan(0);
  });

  it("returns null audioStream for a silent mp4", async () => {
    const probe = await ffprobe(getMedia().silentMp4);
    expect(probe.videoStream).not.toBeNull();
    expect(probe.audioStream).toBeNull();
  });

  it("identifies an mp3 audio file", async () => {
    const probe = await ffprobe(getMedia().audioMp3);
    expect(probe.videoStream).toBeNull();
    expect(probe.audioStream?.codec).toBe("mp3");
    expect(probe.formatName).toContain("mp3");
  });

  it("identifies a wav audio file", async () => {
    const probe = await ffprobe(getMedia().audioWav);
    expect(probe.videoStream).toBeNull();
    expect(probe.audioStream?.codec).toMatch(/^pcm_/);
    expect(probe.formatName).toContain("wav");
  });

  it("throws on a non-media file", async () => {
    await expect(ffprobe(getMedia().corruptFile)).rejects.toThrow(/ffprobe failed/);
  });
});

describe("transcodeVideo", () => {
  it("produces a playable mp4 with audio when input has audio", async () => {
    await using td = await tempDir("test-transcode-");
    const out = join(td.path, "out.mp4");
    await transcodeVideo(getMedia().videoMp4, out, true);
    expect(existsSync(out)).toBe(true);
    const probe = await ffprobe(out);
    expect(probe.videoStream?.codec).toBe("h264");
    expect(probe.audioStream?.codec).toBe("aac");
  });

  it("produces a silent mp4 when hasAudio=false (-an)", async () => {
    await using td = await tempDir("test-transcode-silent-");
    const out = join(td.path, "out.mp4");
    await transcodeVideo(getMedia().silentMp4, out, false);
    const probe = await ffprobe(out);
    expect(probe.videoStream).not.toBeNull();
    expect(probe.audioStream).toBeNull();
  });

  it("aborts via AbortSignal", async () => {
    await using td = await tempDir("test-abort-");
    const out = join(td.path, "out.mp4");
    const ac = new AbortController();
    ac.abort();
    await expect(transcodeVideo(getMedia().videoMp4, out, true, ac.signal)).rejects.toThrow(
      /aborted/,
    );
  });
});

describe("extractAudio / transcodeAudio", () => {
  it("extracts AAC audio from a video", async () => {
    await using td = await tempDir("test-extract-");
    const out = join(td.path, "out.m4a");
    await extractAudio(getMedia().videoMp4, out);
    const probe = await ffprobe(out);
    expect(probe.audioStream?.codec).toBe("aac");
    expect(probe.videoStream).toBeNull();
  });

  it("normalizes mp3 input to AAC m4a (transcodeAudio is alias of extractAudio)", async () => {
    await using td = await tempDir("test-transcode-audio-");
    const out = join(td.path, "out.m4a");
    await transcodeAudio(getMedia().audioMp3, out);
    const probe = await ffprobe(out);
    expect(probe.audioStream?.codec).toBe("aac");
    expect(probe.audioStream?.sampleRate).toBe(48000);
    expect(probe.audioStream?.channels).toBe(2);
  });
});

describe("extractThumbnails", () => {
  it("emits thumbnails at 10s intervals for an 11s video (t=0 と t=10)", async () => {
    await using td = await tempDir("test-thumbs-");
    const probe = await ffprobe(getMedia().videoMp4);
    const thumbs = await extractThumbnails(
      getMedia().videoMp4,
      td.path,
      probe.durationSec,
      probe.videoStream?.width ?? 320,
      probe.videoStream?.height ?? 240,
    );
    expect(thumbs.length).toBe(2);
    expect(thumbs[0]?.atSec).toBe(0);
    expect(thumbs[1]?.atSec).toBe(10);
    expect(existsSync(thumbs[0]!.path)).toBe(true);
    expect(existsSync(thumbs[1]!.path)).toBe(true);
    expect(thumbs[0]?.width).toBe(320);
  });
});

describe("decodeAudioPcm", () => {
  it("440Hz 正弦波 wav を decode すると CQT の argmax が 440Hz bin になる", async () => {
    const { computeCqt, cqtBinFrequency } = await import("./cqt");
    const fs = 8000;
    const samples = await decodeAudioPcm(getMedia().audioWav, fs);
    expect(samples.length).toBeGreaterThan(fs * 0.9);
    expect(samples.length).toBeLessThan(fs * 1.1);
    const { magnitudes, frames, bins } = await computeCqt(samples, {
      sampleRate: fs,
      binsPerOctave: 12,
      octaves: 5,
      fminHz: 55,
      hop: 64,
    });
    const mid = Math.floor(frames / 2);
    let best = 0;
    for (let k = 1; k < bins; k++) {
      if (magnitudes[mid * bins + k]! > magnitudes[mid * bins + best]!) best = k;
    }
    // 55 * 2^(36/12) = 440
    expect(cqtBinFrequency(55, 12, best)).toBeCloseTo(440, 0);
  });
});
