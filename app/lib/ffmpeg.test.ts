import { describe, expect, it } from "bun:test";
import { isBrowserPlayableAudio } from "./ffmpeg";

describe("isBrowserPlayableAudio", () => {
  it("accepts AAC in mp4 container (m4a)", () => {
    expect(isBrowserPlayableAudio("aac", "mov,mp4,m4a,3gp,3g2,mj2")).toBe(true);
  });

  it("accepts MP3 in mp3 container", () => {
    expect(isBrowserPlayableAudio("mp3", "mp3")).toBe(true);
  });

  it("accepts FLAC in flac container", () => {
    expect(isBrowserPlayableAudio("flac", "flac")).toBe(true);
  });

  it("accepts Opus in ogg container", () => {
    expect(isBrowserPlayableAudio("opus", "ogg")).toBe(true);
  });

  it("accepts PCM in wav container", () => {
    expect(isBrowserPlayableAudio("pcm_s16le", "wav")).toBe(true);
  });

  it("rejects ALAC even in mp4 (no major browser supports it natively)", () => {
    expect(isBrowserPlayableAudio("alac", "mov,mp4,m4a,3gp,3g2,mj2")).toBe(false);
  });

  it("rejects WMA", () => {
    expect(isBrowserPlayableAudio("wmav2", "asf")).toBe(false);
  });

  it("rejects DTS", () => {
    expect(isBrowserPlayableAudio("dts", "wav")).toBe(false);
  });

  it("rejects AAC in unsupported container", () => {
    expect(isBrowserPlayableAudio("aac", "rtsp")).toBe(false);
  });

  it("rejects empty inputs", () => {
    expect(isBrowserPlayableAudio("", "")).toBe(false);
    expect(isBrowserPlayableAudio("aac", "")).toBe(false);
    expect(isBrowserPlayableAudio("", "mp4")).toBe(false);
  });
});
