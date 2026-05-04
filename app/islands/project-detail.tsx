import { useEffect, useMemo, useRef, useState } from "react";

export type Thumb = { id: string; atSec: number; url: string; width: number; height: number };
export type VideoItem = {
  id: string;
  name: string;
  order: number;
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  sizeBytes: number;
  srcStartSec: number;
  srcEndSec: number;
  projStartSec: number;
  projEndSec: number;
  streamUrl: string;
  audioUrl: string | null;
  thumbnails: Thumb[];
};
export type AudioItem = {
  id: string;
  name: string;
  order: number;
  durationSec: number;
  contentType: string;
  sampleRate: number | null;
  channels: number | null;
  sizeBytes: number;
  srcStartSec: number;
  srcEndSec: number;
  projStartSec: number;
  projEndSec: number;
  streamUrl: string;
};
export type ProjectDetailData = {
  id: string;
  name: string;
  videos: VideoItem[];
  audios: AudioItem[];
};

type Track = { kind: "video"; data: VideoItem } | { kind: "audio"; data: AudioItem };

const TRACK_HEIGHT = 64;
const TRACK_GAP = 8;
const PIXELS_PER_SECOND_DEFAULT = 40;
const SYNC_DRIFT_TOLERANCE = 0.25;

export default function ProjectDetail({ initial }: { initial: ProjectDetailData }) {
  const [data, setData] = useState(initial);
  const [pxPerSec, setPxPerSec] = useState(PIXELS_PER_SECOND_DEFAULT);
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const tracks: Track[] = useMemo(() => {
    const all: Track[] = [
      ...data.videos.map((v) => ({ kind: "video" as const, data: v })),
      ...data.audios.map((a) => ({ kind: "audio" as const, data: a })),
    ];
    return all.toSorted((a, b) => a.data.order - b.data.order);
  }, [data]);

  const projectDuration = useMemo(() => {
    const ends = tracks.map((t) => Math.max(t.data.projStartSec, t.data.projEndSec));
    return Math.max(60, ...ends);
  }, [tracks]);

  const mediaRefs = useRef(new Map<string, HTMLMediaElement>());
  const lastTickRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (!playing) {
      lastTickRef.current = null;
      for (const el of mediaRefs.current.values()) el.pause();
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      return;
    }
    const tick = (ts: number) => {
      const last = lastTickRef.current ?? ts;
      const dt = (ts - last) / 1000;
      lastTickRef.current = ts;
      setCurrentTime((prev) => {
        const next = prev + dt;
        if (next >= projectDuration) {
          setPlaying(false);
          return projectDuration;
        }
        return next;
      });
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [playing, projectDuration]);

  useEffect(() => {
    for (const t of tracks) {
      const el = mediaRefs.current.get(trackKey(t));
      if (!el) continue;
      syncMediaElement(el, t.data, currentTime, playing, () => {
        setPlaying(false);
        setError(
          "ブラウザのautoplay制限で再生できませんでした。もう一度再生ボタンを押してください。",
        );
      });
    }
  }, [tracks, currentTime, playing]);

  async function refresh() {
    const res = await fetch(`/api/projects/${data.id}`);
    if (!res.ok) return;
    const body = (await res.json()) as { project: ServerProject };
    setData(toClient(body.project));
  }

  async function uploadVideo(file: File) {
    setBusy("video");
    setError(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("name", file.name);
      const res = await fetch(`/api/projects/${data.id}/videos`, { method: "POST", body: fd });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `アップロード失敗 (HTTP ${res.status})`);
        return;
      }
      await refresh();
    } finally {
      setBusy(null);
    }
  }
  async function uploadAudio(file: File) {
    setBusy("audio");
    setError(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("name", file.name);
      const res = await fetch(`/api/projects/${data.id}/audios`, { method: "POST", body: fd });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `アップロード失敗 (HTTP ${res.status})`);
        return;
      }
      await refresh();
    } finally {
      setBusy(null);
    }
  }

  // ブラウザのautoplay policyはuser-gesture同期コンテキストで呼ばれた play() しか許さない。
  // useEffect 経由だと初回再生で NotAllowedError になるので、クリックハンドラ内で
  // 全媒体を一度 play() して unlock した上で playing=true にする
  function startPlayback() {
    let blocked = false;
    for (const t of tracks) {
      const el = mediaRefs.current.get(trackKey(t));
      if (!el) continue;
      const projLow = Math.min(t.data.projStartSec, t.data.projEndSec);
      const projHigh = Math.max(t.data.projStartSec, t.data.projEndSec);
      const inRange = currentTime >= projLow && currentTime <= projHigh;
      const promise = el.play();
      if (promise && typeof promise.catch === "function") {
        promise.catch((err: unknown) => {
          // pause() を被せた時の AbortError は想定内、それ以外は autoplay block
          if (err instanceof DOMException && err.name === "AbortError") return;
          if (!blocked) {
            blocked = true;
            setPlaying(false);
            setError("ブラウザのautoplay制限で再生できませんでした。もう一度押してください。");
          }
        });
      }
      if (!inRange) el.pause();
    }
    setError(null);
    setPlaying(true);
  }

  async function deleteTrack(t: Track) {
    if (!confirm("削除しますか？")) return;
    const url =
      t.kind === "video"
        ? `/api/projects/${data.id}/videos/${t.data.id}`
        : `/api/projects/${data.id}/audios/${t.data.id}`;
    const res = await fetch(url, { method: "DELETE" });
    if (res.ok || res.status === 204) await refresh();
    else setError(`削除失敗 (HTTP ${res.status})`);
  }

  const totalWidth = projectDuration * pxPerSec;

  return (
    <div>
      <header style={{ display: "flex", alignItems: "baseline", gap: "1rem" }}>
        <a href="/projects">← 一覧</a>
        <h1 style={{ margin: 0 }}>{data.name}</h1>
      </header>

      <section style={{ display: "flex", gap: "1.5rem", margin: "1rem 0", flexWrap: "wrap" }}>
        <UploadField
          label="動画追加"
          accept="video/*"
          disabled={busy !== null}
          onPick={uploadVideo}
          busy={busy === "video"}
        />
        <UploadField
          label="音声追加"
          accept="audio/*"
          disabled={busy !== null}
          onPick={uploadAudio}
          busy={busy === "audio"}
        />
      </section>

      {error && <p style={{ color: "crimson" }}>{error}</p>}

      <section
        style={{ display: "flex", alignItems: "center", gap: "0.75rem", margin: "0.75rem 0" }}
      >
        <button
          type="button"
          onClick={() => (playing ? setPlaying(false) : startPlayback())}
          disabled={tracks.length === 0}
        >
          {playing ? "一時停止" : "再生"}
        </button>
        <button
          type="button"
          onClick={() => {
            setPlaying(false);
            setCurrentTime(0);
          }}
        >
          ⏮
        </button>
        <span style={{ fontVariantNumeric: "tabular-nums" }}>
          {formatTime(currentTime)} / {formatTime(projectDuration)}
        </span>
        <label style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: "0.4rem" }}>
          ズーム
          <input
            type="range"
            min={10}
            max={200}
            value={pxPerSec}
            onChange={(e) => setPxPerSec(Number(e.target.value))}
          />
          <span style={{ fontVariantNumeric: "tabular-nums" }}>{pxPerSec}px/s</span>
        </label>
      </section>

      <div
        style={{
          border: "1px solid #ddd",
          borderRadius: 6,
          overflowX: "auto",
          overflowY: "hidden",
          background: "#fafafa",
        }}
      >
        <div style={{ position: "relative", width: totalWidth, minHeight: 80 }}>
          <TimeRuler duration={projectDuration} pxPerSec={pxPerSec} />
          <div style={{ position: "relative" }}>
            {tracks.map((t, idx) => (
              <TrackRow
                key={trackKey(t)}
                track={t}
                index={idx}
                pxPerSec={pxPerSec}
                onSeek={(time) => {
                  setPlaying(false);
                  setCurrentTime(Math.max(0, Math.min(projectDuration, time)));
                }}
                onDelete={() => deleteTrack(t)}
                attachRef={(el) => {
                  if (el) mediaRefs.current.set(trackKey(t), el);
                  else mediaRefs.current.delete(trackKey(t));
                }}
              />
            ))}
            {tracks.length === 0 && (
              <p style={{ padding: "1rem", color: "#666" }}>動画または音声を追加してください。</p>
            )}
          </div>
          <Playhead
            time={currentTime}
            pxPerSec={pxPerSec}
            height={tracks.length * (TRACK_HEIGHT + TRACK_GAP) + 24}
          />
        </div>
      </div>
    </div>
  );
}

function trackKey(t: Track): string {
  return `${t.kind}:${t.data.id}`;
}

function syncMediaElement(
  el: HTMLMediaElement,
  item: VideoItem | AudioItem,
  projTime: number,
  playing: boolean,
  onPlayError?: (err: unknown) => void,
): void {
  const projLow = Math.min(item.projStartSec, item.projEndSec);
  const projHigh = Math.max(item.projStartSec, item.projEndSec);
  const inside = projTime >= projLow && projTime <= projHigh;
  if (!inside) {
    if (!el.paused) el.pause();
    return;
  }
  const dProj = item.projEndSec - item.projStartSec;
  const dSrc = item.srcEndSec - item.srcStartSec;
  if (dProj === 0 || dSrc === 0) {
    if (!el.paused) el.pause();
    return;
  }
  const rate = dSrc / dProj;
  // <video>/<audio>はnegativeなplaybackRateをサポートしないので逆再生中は無音表示
  if (rate <= 0) {
    if (!el.paused) el.pause();
    return;
  }
  const mediaT = item.srcStartSec + ((projTime - item.projStartSec) / dProj) * dSrc;
  el.playbackRate = Math.min(16, Math.max(0.0625, rate));
  if (Math.abs(el.currentTime - mediaT) > SYNC_DRIFT_TOLERANCE) {
    el.currentTime = mediaT;
  }
  if (playing) {
    if (el.paused) {
      void el.play().catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        onPlayError?.(err);
      });
    }
  } else if (!el.paused) {
    el.pause();
  }
}

function TimeRuler({ duration, pxPerSec }: { duration: number; pxPerSec: number }) {
  const step = chooseStep(pxPerSec);
  const ticks: number[] = [];
  for (let t = 0; t <= duration; t += step) ticks.push(t);
  return (
    <div
      style={{
        position: "relative",
        height: 24,
        borderBottom: "1px solid #ccc",
        color: "#666",
        fontSize: 11,
      }}
    >
      {ticks.map((t) => (
        <div
          key={t}
          style={{
            position: "absolute",
            left: t * pxPerSec,
            top: 0,
            bottom: 0,
            borderLeft: "1px solid #ddd",
            paddingLeft: 2,
          }}
        >
          {formatTime(t)}
        </div>
      ))}
    </div>
  );
}

function chooseStep(pxPerSec: number): number {
  const candidates = [1, 2, 5, 10, 30, 60, 120, 300];
  for (const c of candidates) {
    if (c * pxPerSec >= 60) return c;
  }
  return 600;
}

function Playhead({ time, pxPerSec, height }: { time: number; pxPerSec: number; height: number }) {
  return (
    <div
      style={{
        position: "absolute",
        top: 0,
        left: time * pxPerSec,
        width: 2,
        height,
        background: "crimson",
        pointerEvents: "none",
        boxShadow: "0 0 4px rgba(220,20,60,0.5)",
      }}
    />
  );
}

function TrackRow({
  track,
  index,
  pxPerSec,
  onSeek,
  onDelete,
  attachRef,
}: {
  track: Track;
  index: number;
  pxPerSec: number;
  onSeek: (time: number) => void;
  onDelete: () => void;
  attachRef: (el: HTMLMediaElement | null) => void;
}) {
  const item = track.data;
  const projLow = Math.min(item.projStartSec, item.projEndSec);
  const projHigh = Math.max(item.projStartSec, item.projEndSec);
  const left = projLow * pxPerSec;
  const width = Math.max(2, (projHigh - projLow) * pxPerSec);
  const reversed = item.projEndSec < item.projStartSec;
  const speed =
    item.projEndSec === item.projStartSec
      ? 0
      : (item.srcEndSec - item.srcStartSec) / (item.projEndSec - item.projStartSec);

  const top = index * (TRACK_HEIGHT + TRACK_GAP);
  const color = track.kind === "video" ? "#3b82f6" : "#10b981";

  return (
    <div
      style={{
        position: "absolute",
        top,
        left: 0,
        right: 0,
        height: TRACK_HEIGHT,
      }}
    >
      <button
        type="button"
        aria-label={`${item.name} を選択してシーク`}
        onClick={(e) => {
          const parent = e.currentTarget.parentElement as HTMLDivElement;
          const bounds = parent.getBoundingClientRect();
          const x = e.clientX - bounds.left + parent.scrollLeft;
          onSeek(x / pxPerSec);
        }}
        style={{
          position: "absolute",
          inset: 0,
          background: "transparent",
          border: "none",
          padding: 0,
          margin: 0,
          cursor: "pointer",
        }}
      />
      <div
        style={{
          position: "absolute",
          left,
          top: 0,
          width,
          height: TRACK_HEIGHT,
          background: color,
          color: "white",
          borderRadius: 4,
          padding: "2px 6px",
          overflow: "hidden",
          boxShadow: "0 1px 2px rgba(0,0,0,0.15)",
          fontSize: 12,
          pointerEvents: "none",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span
            style={{
              fontWeight: 600,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            [{track.kind === "video" ? "V" : "A"}] {item.name}
          </span>
        </div>
        <div style={{ opacity: 0.85, fontSize: 10 }}>
          {formatTime(item.durationSec)} / {speed.toFixed(2)}x{reversed ? " (逆)" : ""}
        </div>
        {track.kind === "video" && (
          <ThumbnailStrip video={item as VideoItem} pxPerSec={pxPerSec} trackWidth={width} />
        )}
      </div>
      <button
        type="button"
        aria-label={`${item.name} を削除`}
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        style={{
          position: "absolute",
          left: left + width - 22,
          top: 4,
          background: "rgba(0,0,0,0.45)",
          border: "none",
          color: "white",
          cursor: "pointer",
          fontSize: 11,
          padding: "0 6px",
          borderRadius: 3,
          lineHeight: "16px",
        }}
      >
        ×
      </button>
      {track.kind === "video" ? (
        <video
          ref={attachRef as (el: HTMLVideoElement | null) => void}
          src={(item as VideoItem).streamUrl}
          preload="auto"
          style={{ display: "none" }}
          aria-hidden="true"
        >
          <track kind="captions" />
        </video>
      ) : (
        <audio
          ref={attachRef as (el: HTMLAudioElement | null) => void}
          src={(item as AudioItem).streamUrl}
          preload="auto"
          style={{ display: "none" }}
          aria-hidden="true"
        >
          <track kind="captions" />
        </audio>
      )}
    </div>
  );
}

function ThumbnailStrip({
  video,
  pxPerSec,
  trackWidth,
}: {
  video: VideoItem;
  pxPerSec: number;
  trackWidth: number;
}) {
  if (video.thumbnails.length === 0) return null;
  const dProj = video.projEndSec - video.projStartSec;
  const dSrc = video.srcEndSec - video.srcStartSec;
  if (dProj === 0 || dSrc === 0) return null;
  const projOffsetMin = Math.min(video.projStartSec, video.projEndSec);
  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: 2,
        height: 28,
        pointerEvents: "none",
      }}
    >
      {video.thumbnails.map((t) => {
        const projT = video.projStartSec + ((t.atSec - video.srcStartSec) / dSrc) * dProj;
        const x = (projT - projOffsetMin) * pxPerSec;
        if (x < -32 || x > trackWidth + 32) return null;
        return (
          <img
            key={t.id}
            src={t.url}
            alt=""
            style={{
              position: "absolute",
              left: x,
              bottom: 0,
              height: 28,
              border: "1px solid rgba(255,255,255,0.4)",
            }}
          />
        );
      })}
    </div>
  );
}

function UploadField({
  label,
  accept,
  disabled,
  busy,
  onPick,
}: {
  label: string;
  accept: string;
  disabled: boolean;
  busy: boolean;
  onPick: (file: File) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <div>
      <label style={{ display: "inline-flex", alignItems: "center", gap: "0.5rem" }}>
        <span>{label}</span>
        <input
          ref={ref}
          type="file"
          accept={accept}
          disabled={disabled}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onPick(f);
            if (ref.current) ref.current.value = "";
          }}
        />
      </label>
      {busy && <span style={{ marginLeft: "0.5rem", color: "#666" }}>処理中…</span>}
    </div>
  );
}

function formatTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, "0")}`;
}

type ServerProject = {
  id: string;
  name: string;
  videos: (Omit<VideoItem, "streamUrl" | "audioUrl" | "thumbnails"> & {
    audioKey: string | null;
    thumbnails: { id: string; atSec: number; key: string; width: number; height: number }[];
  })[];
  audios: Omit<AudioItem, "streamUrl">[];
};

function toClient(p: ServerProject): ProjectDetailData {
  return {
    id: p.id,
    name: p.name,
    videos: p.videos.map((v) => ({
      ...v,
      streamUrl: `/api/projects/${p.id}/videos/${v.id}/stream`,
      audioUrl: v.audioKey ? `/api/projects/${p.id}/videos/${v.id}/audio` : null,
      thumbnails: v.thumbnails.map((t) => ({
        id: t.id,
        atSec: t.atSec,
        url: `/api/projects/${p.id}/videos/${v.id}/thumbnails/${t.id}`,
        width: t.width,
        height: t.height,
      })),
    })),
    audios: p.audios.map((a) => ({
      ...a,
      streamUrl: `/api/projects/${p.id}/audios/${a.id}/stream`,
    })),
  };
}
