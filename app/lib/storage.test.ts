import { describe, expect, it } from "bun:test";
import {
  audioPrefix,
  audioRawKey,
  audioTranscodedKey,
  projectKey,
  projectPrefix,
  uploadChunkKey,
  uploadPrefix,
  videoAudioKey,
  videoPrefix,
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

  it("upload prefix と chunk key を 7桁 0-pad + writeId で発番する", () => {
    const pid = "p_1";
    const uid = "u_1";
    const w = "abc";
    expect(uploadPrefix(pid, uid)).toBe("projects/p_1/uploads/u_1/");
    expect(uploadChunkKey(pid, uid, 0, w)).toBe("projects/p_1/uploads/u_1/chunks/0000000-abc");
    expect(uploadChunkKey(pid, uid, 42, w)).toBe("projects/p_1/uploads/u_1/chunks/0000042-abc");
    expect(uploadChunkKey(pid, uid, 9999999, w)).toBe(
      "projects/p_1/uploads/u_1/chunks/9999999-abc",
    );
  });

  // prefix 系は deletePrefix / DeletionMark.prefix で使うため trailing slash 必須
  describe("projectPrefix / videoPrefix / audioPrefix", () => {
    it("returns prefixes with trailing slash so deletePrefix doesn't accidentally match siblings", () => {
      expect(projectPrefix("p_1")).toBe("projects/p_1/");
      expect(videoPrefix("p_1", "v_1")).toBe("projects/p_1/videos/v_1/");
      expect(audioPrefix("p_1", "a_1")).toBe("projects/p_1/audios/a_1/");
    });

    it("video/audio prefixes are subpaths of the project prefix", () => {
      const pid = "p_x";
      expect(videoPrefix(pid, "v_x").startsWith(projectPrefix(pid))).toBe(true);
      expect(audioPrefix(pid, "a_x").startsWith(projectPrefix(pid))).toBe(true);
    });

    it("video/audio keys live under their respective prefixes", () => {
      const pid = "p_y";
      const vid = "v_y";
      const aid = "a_y";
      expect(videoSourceKey(pid, vid).startsWith(videoPrefix(pid, vid))).toBe(true);
      expect(videoAudioKey(pid, vid).startsWith(videoPrefix(pid, vid))).toBe(true);
      expect(videoThumbKey(pid, vid, 0).startsWith(videoPrefix(pid, vid))).toBe(true);
      expect(audioTranscodedKey(pid, aid).startsWith(audioPrefix(pid, aid))).toBe(true);
      expect(audioRawKey(pid, aid, "wav").startsWith(audioPrefix(pid, aid))).toBe(true);
    });
  });
});
