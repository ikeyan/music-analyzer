import { describe, expect, it } from "bun:test";
import {
  audioRawKey,
  audioTranscodedKey,
  projectKey,
  uploadChunkKey,
  uploadPrefix,
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
    expect(audioRawKey(pid, aid, "wav")).toBe("projects/p_123/audios/a_xyz/raw.wav");
    expect(audioRawKey(pid, aid, ".flac")).toBe("projects/p_123/audios/a_xyz/raw.flac");
    expect(audioTranscodedKey(pid, aid)).toBe("projects/p_123/audios/a_xyz/transcoded.m4a");
  });

  it("zero-pads thumbnail seconds for stable lex ordering", () => {
    const pid = "p_1";
    const vid = "v_1";
    expect(videoThumbKey(pid, vid, 0)).toBe("projects/p_1/videos/v_1/thumbs/000000.jpg");
    expect(videoThumbKey(pid, vid, 10)).toBe("projects/p_1/videos/v_1/thumbs/000010.jpg");
    expect(videoThumbKey(pid, vid, 3590)).toBe("projects/p_1/videos/v_1/thumbs/003590.jpg");
  });

  it("upload prefix と chunk key を 7桁 0-pad で発番する", () => {
    const pid = "p_1";
    const uid = "u_1";
    expect(uploadPrefix(pid, uid)).toBe("projects/p_1/uploads/u_1/");
    expect(uploadChunkKey(pid, uid, 0)).toBe("projects/p_1/uploads/u_1/chunks/0000000");
    expect(uploadChunkKey(pid, uid, 42)).toBe("projects/p_1/uploads/u_1/chunks/0000042");
    expect(uploadChunkKey(pid, uid, 9999999)).toBe("projects/p_1/uploads/u_1/chunks/9999999");
  });
});
