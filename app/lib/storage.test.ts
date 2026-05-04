import { describe, expect, it } from "bun:test";
import {
  audioSourceKey,
  projectKey,
  videoAudioKey,
  videoSourceKey,
  videoThumbKey,
} from "./storage";

describe("storage paths", () => {
  it("namespaces all keys under the project id", () => {
    const pid = "p_123";
    const vid = "v_abc";
    const aid = "a_xyz";
    expect(projectKey(pid)).toBe("projects/p_123");
    expect(videoSourceKey(pid, vid)).toBe("projects/p_123/videos/v_abc/source.mp4");
    expect(videoAudioKey(pid, vid)).toBe("projects/p_123/videos/v_abc/audio.m4a");
    expect(audioSourceKey(pid, aid, "wav")).toBe("projects/p_123/audios/a_xyz/source.wav");
    expect(audioSourceKey(pid, aid, ".flac")).toBe("projects/p_123/audios/a_xyz/source.flac");
  });

  it("zero-pads thumbnail seconds for stable lex ordering", () => {
    const pid = "p_1";
    const vid = "v_1";
    expect(videoThumbKey(pid, vid, 0)).toBe("projects/p_1/videos/v_1/thumbs/000000.jpg");
    expect(videoThumbKey(pid, vid, 10)).toBe("projects/p_1/videos/v_1/thumbs/000010.jpg");
    expect(videoThumbKey(pid, vid, 3590)).toBe("projects/p_1/videos/v_1/thumbs/003590.jpg");
  });
});
