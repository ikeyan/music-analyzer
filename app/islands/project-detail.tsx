import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  ApiAudio,
  ApiProjectDetail,
  ApiSpectrogram,
  ApiTask,
  ApiThumbnail,
  ApiVideo,
} from "../api/types";
import {
  HarmonicLens,
  type LensHover,
  SPECTROGRAM_STRIP_HEIGHT,
  type SpectrogramCreateParams,
  SpectrogramDialogBody,
  type SpectrogramSelection,
  SpectrogramStrip,
} from "../components/spectrogram";
import { apiClient } from "../lib/api-client";
import { chunkedUpload } from "../lib/chunked-upload";
import { loadLocal, saveLocal } from "../lib/local-store";

export type Thumb = ApiThumbnail;
export type VideoItem = ApiVideo;
export type AudioItem = ApiAudio;
export type ProjectDetailData = ApiProjectDetail;

// active task がある間 1s 間隔で refresh (succeeded 後の Video/Audio 反映も兼ねる)
const TASK_POLL_INTERVAL_MS = 1000;

type Track = { kind: "video"; data: VideoItem } | { kind: "audio"; data: AudioItem };
type ShownSpec = { spec: ApiSpectrogram; mode: string; audio: AudioItem };

// タイトル + 操作ボタンは行左上に sticky で重ね (縦積み)、横スクロールでも画面内に残す。
// 緑の clip 帯は info とサムネイルだけ持たせて低く保つ
const TRACK_HEIGHT = 56;
const TRACK_GAP = 8;
const PIXELS_PER_SECOND_DEFAULT = 40;
const SYNC_DRIFT_TOLERANCE = 0.25;

type TrackRef = { kind: Track["kind"]; id: string };
type TimingUpdate = {
  srcStartSec: number;
  srcEndSec: number;
  projStartSec: number;
  projEndSec: number;
};

export default function ProjectDetail({ initial }: { initial: ProjectDetailData }) {
  const [data, setData] = useState(initial);
  const [pxPerSec, setPxPerSec] = useState(PIXELS_PER_SECOND_DEFAULT);
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<TrackRef | null>(null);
  const [trimming, setTrimming] = useState<TrackRef | null>(null);
  const [specDialog, setSpecDialog] = useState<string | null>(null);
  const [specViews, setSpecViews] = useState<Record<string, SpectrogramSelection | undefined>>({});
  // harmonic CQT lens: spectrogram 表示中の audio 行を hover している間だけ出す
  const [lens, setLens] = useState<(LensHover & { audioId: string }) | null>(null);
  // 再生位置レンズ: ON の間は hover ではなく再生ヘッド時刻で各表示行にレンズを出す
  const [playbackLens, setPlaybackLens] = useState(false);
  // 再生中に再生ヘッドを画面内に保つよう横スクロールを追従させる
  const [autoScroll, setAutoScroll] = useState(false);
  // ソロ再生: 指定 track だけ鳴らし、再生位置レンズもその track だけ出す
  const [solo, setSolo] = useState<TrackRef | null>(null);
  const rowsRef = useRef<HTMLDivElement | null>(null);

  // 表示状態 (specViews) と再生位置レンズの ON/OFF を project 単位で localStorage に保存。
  // hydration mismatch を避けるため初期値は空で mount 後に読み込む。save effect を load より
  // 先に定義することで、mount commit では restoredRef=false で save が skip され、初期空値で
  // 保存データを潰さない (load が state を当てた次の commit から保存が効く)
  const viewsKey = `cqtViews:${data.id}`;
  const lensKey = `cqtPlaybackLens:${data.id}`;
  const autoScrollKey = `cqtAutoScroll:${data.id}`;
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current) saveLocal(viewsKey, specViews);
  }, [viewsKey, specViews]);
  useEffect(() => {
    if (restoredRef.current) saveLocal(lensKey, playbackLens);
  }, [lensKey, playbackLens]);
  useEffect(() => {
    if (restoredRef.current) saveLocal(autoScrollKey, autoScroll);
  }, [autoScrollKey, autoScroll]);
  useEffect(() => {
    setSpecViews(loadLocal(viewsKey, {} as Record<string, SpectrogramSelection | undefined>));
    setPlaybackLens(loadLocal(lensKey, false));
    setAutoScroll(loadLocal(autoScrollKey, false));
    restoredRef.current = true;
  }, [viewsKey, lensKey, autoScrollKey]);

  const tracks: Track[] = useMemo(() => {
    const all: Track[] = [
      ...data.videos.map((v) => ({ kind: "video" as const, data: v })),
      ...data.audios.map((a) => ({ kind: "audio" as const, data: a })),
    ];
    return all.toSorted((a, b) => a.data.order - b.data.order);
  }, [data]);

  // 削除済み track を指したままの solo は無効化する (全 track が soloed-out で無音になるのを防ぐ)
  const activeSolo = useMemo(
    () => (solo && tracks.some((t) => t.kind === solo.kind && t.data.id === solo.id) ? solo : null),
    [solo, tracks],
  );
  const isSoloedOut = useCallback(
    (t: Track) =>
      activeSolo !== null && !(activeSolo.kind === t.kind && activeSolo.id === t.data.id),
    [activeSolo],
  );

  // playEnd で再生停止、displayDuration (>=60s) で ruler の最低幅を確保
  const playEnd = useMemo(
    () =>
      tracks.length === 0
        ? 0
        : Math.max(...tracks.map((t) => Math.max(t.data.projStartSec, t.data.projEndSec))),
    [tracks],
  );
  const displayDuration = useMemo(() => Math.max(60, playEnd), [playEnd]);

  // spectrogram の lazy load 用に横スクロール viewport を追跡する (rAF で間引き)
  const scrollBoxRef = useRef<HTMLDivElement | null>(null);
  const [viewport, setViewport] = useState({ left: 0, width: 1200 });
  useEffect(() => {
    const el = scrollBoxRef.current;
    if (!el) return;
    let raf: number | null = null;
    const measure = () => {
      raf = null;
      setViewport((prev) => {
        const next = { left: el.scrollLeft, width: el.clientWidth };
        return prev.left === next.left && prev.width === next.width ? prev : next;
      });
    };
    const schedule = () => {
      if (raf === null) raf = requestAnimationFrame(measure);
    };
    measure();
    el.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      if (raf !== null) cancelAnimationFrame(raf);
      el.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, []);

  const mediaRefs = useRef(new Map<string, HTMLMediaElement>());
  const lastTickRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);
  // unlock 待ちの track を syncMediaElement の pause から除外する。
  // 同期 pause で play() を AbortError にすると unlock 失敗になる
  const unlockingRef = useRef(new Set<string>());

  // 全媒体を unconditionally pause する場合 (playing=false に遷移した時) も
  // unlock 中の元素を巻き込まないよう一覧でスキップする
  function pauseAllExceptUnlocking(): void {
    for (const [key, el] of mediaRefs.current) {
      if (unlockingRef.current.has(key)) continue;
      el.pause();
    }
  }

  useEffect(() => {
    if (!playing) {
      lastTickRef.current = null;
      pauseAllExceptUnlocking();
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      return;
    }
    const tick = (ts: number) => {
      const last = lastTickRef.current ?? ts;
      const dt = (ts - last) / 1000;
      lastTickRef.current = ts;
      setCurrentTime((prev) => {
        const next = prev + dt;
        if (next >= playEnd) {
          setPlaying(false);
          return playEnd;
        }
        return next;
      });
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [playing, playEnd]);

  // 自動スクロール: 再生中は currentTime が毎フレーム更新されるので、その度に
  // 再生ヘッドを viewport 中央に置く scrollLeft を書いて連続的に追従する
  useEffect(() => {
    if (!playing || !autoScroll) return;
    const el = scrollBoxRef.current;
    if (!el) return;
    const max = Math.max(0, el.scrollWidth - el.clientWidth);
    el.scrollLeft = Math.max(0, Math.min(max, currentTime * pxPerSec - el.clientWidth / 2));
  }, [playing, autoScroll, currentTime, pxPerSec]);

  useEffect(() => {
    for (const t of tracks) {
      const key = trackKey(t);
      // unlock 中は play() を pause で abort せず .then の resolve に任せる
      if (unlockingRef.current.has(key)) continue;
      const el = mediaRefs.current.get(key);
      if (!el) continue;
      // solo 中は対象外の track を鳴らさない (音は止めるが seek 追従は不要)
      if (isSoloedOut(t)) {
        if (!el.paused) el.pause();
        continue;
      }
      syncMediaElement(el, t.data, currentTime, playing, () => {
        setPlaying(false);
        setError(
          "ブラウザのautoplay制限で再生できませんでした。もう一度再生ボタンを押してください。",
        );
      });
    }
  }, [tracks, currentTime, playing, isSoloedOut]);

  const projectId = data.id;
  const refresh = useCallback(async () => {
    const res = await apiClient.projects[":id"].$get({ param: { id: projectId } });
    if (!res.ok) return;
    const body = await res.json();
    setData(body.project);
  }, [projectId]);

  async function uploadMedia(kind: "video" | "audio", file: File) {
    setBusy(kind);
    setError(null);
    try {
      const result = await chunkedUpload(
        apiClient,
        data.id,
        kind,
        file,
        file.name,
        file.type || undefined,
      );
      if (!result.ok) {
        const label = kind === "video" ? "動画" : "音声";
        setError(`${label} upload 失敗 (HTTP ${result.status}): ${result.error}`);
        return;
      }
      // refresh が transient error で失敗しても polling effect が動くよう task を直接 seed
      setData((d) => ({
        ...d,
        tasks: [result.task, ...d.tasks.filter((t) => t.id !== result.task.id)],
      }));
      await refresh();
    } finally {
      setBusy(null);
    }
  }

  // boolean に縮約して effect の再 mount を抑える
  const hasActiveTasks = useMemo(
    () => data.tasks.some((t) => t.status === "pending" || t.status === "running"),
    [data.tasks],
  );
  useEffect(() => {
    if (!hasActiveTasks) return;
    const timer = setInterval(() => {
      void refresh();
    }, TASK_POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [hasActiveTasks, refresh]);

  // user-gesture 内で play().then(pause) して全 track を unlock。範囲外は mute で音漏れを防ぐ。
  // 範囲外要素は unlocking フラグで syncMediaElement の同期 pause から除外する
  function startPlayback() {
    let blocked = false;
    for (const t of tracks) {
      const key = trackKey(t);
      const el = mediaRefs.current.get(key);
      if (!el) continue;
      const projLow = Math.min(t.data.projStartSec, t.data.projEndSec);
      const projHigh = Math.max(t.data.projStartSec, t.data.projEndSec);
      const inRange = !isSoloedOut(t) && currentTime >= projLow && currentTime <= projHigh;
      const wasMuted = el.muted;
      if (!inRange) {
        el.muted = true;
        unlockingRef.current.add(key);
      }
      const promise = el.play();
      if (promise && typeof promise.then === "function") {
        promise
          .then(() => {
            if (!inRange) {
              el.pause();
              el.muted = wasMuted;
              unlockingRef.current.delete(key);
            }
          })
          .catch((err: unknown) => {
            if (!inRange) {
              el.muted = wasMuted;
              unlockingRef.current.delete(key);
            }
            if (err instanceof DOMException && err.name === "AbortError") return;
            if (!blocked) {
              blocked = true;
              setPlaying(false);
              setError("ブラウザのautoplay制限で再生できませんでした。もう一度押してください。");
            }
          });
      } else if (!inRange) {
        unlockingRef.current.delete(key);
      }
    }
    setError(null);
    setPlaying(true);
  }

  async function deleteTrack(t: Track) {
    if (!confirm("削除しますか？")) return;
    const res =
      t.kind === "video"
        ? await apiClient.projects[":id"].videos[":videoId"].$delete({
            param: { id: data.id, videoId: t.data.id },
          })
        : await apiClient.projects[":id"].audios[":audioId"].$delete({
            param: { id: data.id, audioId: t.data.id },
          });
    if (res.ok) await refresh();
    else setError(`削除失敗 (HTTP ${res.status})`);
  }

  async function moveTrack(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= tracks.length) return;
    const next = [...tracks];
    [next[index], next[target]] = [next[target]!, next[index]!];
    const res = await apiClient.projects[":id"]["track-order"].$patch({
      param: { id: data.id },
      json: { tracks: next.map((t) => ({ kind: t.kind, id: t.data.id })) },
    });
    if (res.ok) {
      const body = await res.json();
      setData(body.project);
    } else {
      setError(`並び替え失敗 (HTTP ${res.status})`);
    }
  }

  async function updateTiming(
    ref: TrackRef,
    timing: TimingUpdate,
  ): Promise<{ ok: true } | { error: string }> {
    const res =
      ref.kind === "video"
        ? await apiClient.projects[":id"].videos[":videoId"].timing.$patch({
            param: { id: data.id, videoId: ref.id },
            json: timing,
          })
        : await apiClient.projects[":id"].audios[":audioId"].timing.$patch({
            param: { id: data.id, audioId: ref.id },
            json: timing,
          });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      return { error: `更新失敗 (HTTP ${res.status}): ${body.error ?? "(no message)"}` };
    }
    await refresh();
    return { ok: true };
  }

  async function createSpectrogram(
    audioId: string,
    params: SpectrogramCreateParams,
  ): Promise<{ ok: true } | { error: string }> {
    const res = await apiClient.projects[":id"].audios[":audioId"].spectrograms.$post({
      param: { id: data.id, audioId },
      json: params,
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      return { error: `CQT 生成開始失敗 (HTTP ${res.status}): ${body.error ?? "(no message)"}` };
    }
    const body = await res.json();
    // refresh 失敗時も polling effect が動くよう task を直接 seed (uploadMedia と同じ)
    setData((d) => ({
      ...d,
      tasks: [body.task, ...d.tasks.filter((t) => t.id !== body.task.id)],
    }));
    await refresh();
    return { ok: true };
  }

  async function deleteSpectrogram(
    audioId: string,
    specId: string,
  ): Promise<{ ok: true } | { error: string }> {
    const res = await apiClient.projects[":id"].audios[":audioId"].spectrograms[":specId"].$delete({
      param: { id: data.id, audioId, specId },
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      return { error: `削除失敗 (HTTP ${res.status}): ${body.error ?? "(no message)"}` };
    }
    await refresh();
    return { ok: true };
  }

  const editingTrack = useMemo(
    () =>
      editing ? tracks.find((t) => t.kind === editing.kind && t.data.id === editing.id) : null,
    [editing, tracks],
  );
  const trimmingTrack = useMemo(
    () =>
      trimming ? tracks.find((t) => t.kind === trimming.kind && t.data.id === trimming.id) : null,
    [trimming, tracks],
  );

  const totalWidth = displayDuration * pxPerSec;

  // spectrogram 表示中の audio 行だけ高さを広げるため、行の top/height を累積で持つ
  type RowInfo = {
    top: number;
    height: number;
    shownSpec: ShownSpec | null;
  };
  const rowInfos: RowInfo[] = useMemo(() => {
    let top = 0;
    return tracks.map((t) => {
      let shownSpec: RowInfo["shownSpec"] = null;
      if (t.kind === "audio") {
        const sel = specViews[t.data.id];
        const spec = sel ? t.data.spectrograms.find((s) => s.id === sel.specId) : undefined;
        if (sel && spec && spec.status === "ready") {
          shownSpec = { spec, mode: sel.mode, audio: t.data };
        }
      }
      const height = TRACK_HEIGHT + (shownSpec ? SPECTROGRAM_STRIP_HEIGHT + 4 : 0);
      const info = { top, height, shownSpec };
      top += height + TRACK_GAP;
      return info;
    });
  }, [tracks, specViews]);
  const tracksTotalHeight =
    rowInfos.length === 0
      ? 0
      : rowInfos[rowInfos.length - 1]!.top + rowInfos[rowInfos.length - 1]!.height + TRACK_GAP;

  const specDialogAudio = specDialog
    ? (data.audios.find((a) => a.id === specDialog) ?? null)
    : null;

  const lensTarget = lens
    ? (rowInfos.find((i) => i.shownSpec?.audio.id === lens.audioId)?.shownSpec ?? null)
    : null;

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
          onPick={(f) => uploadMedia("video", f)}
          busy={busy === "video"}
        />
        <UploadField
          label="音声追加"
          accept="audio/*"
          disabled={busy !== null}
          onPick={(f) => uploadMedia("audio", f)}
          busy={busy === "audio"}
        />
      </section>

      {error && (
        <p
          role="alert"
          style={{
            color: "crimson",
            background: "#fff5f5",
            border: "1px solid crimson",
            padding: "0.5rem 0.75rem",
            borderRadius: 4,
            margin: "0.5rem 0",
            whiteSpace: "pre-wrap",
          }}
        >
          {error}
        </p>
      )}

      {data.tasks.length > 0 && <TaskList tasks={data.tasks} />}

      <section
        style={{ display: "flex", alignItems: "center", gap: "0.75rem", margin: "0.75rem 0" }}
      >
        <button
          type="button"
          aria-label={playing ? "pause" : "play"}
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
          {formatTime(currentTime)} / {formatTime(playEnd)}
        </span>
        <label
          style={{ display: "flex", alignItems: "center", gap: "0.3rem", fontSize: 13 }}
          title="ON の間はマウスではなく再生ヘッドの時刻で各 spectrogram 行に CQT レンズを出します"
        >
          <input
            type="checkbox"
            checked={playbackLens}
            onChange={(e) => setPlaybackLens(e.target.checked)}
          />
          再生位置レンズ
        </label>
        <label
          style={{ display: "flex", alignItems: "center", gap: "0.3rem", fontSize: 13 }}
          title="再生中、再生ヘッドを画面内に保つよう横スクロールを追従させます"
        >
          <input
            type="checkbox"
            checked={autoScroll}
            onChange={(e) => setAutoScroll(e.target.checked)}
          />
          自動スクロール
        </label>
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
        ref={scrollBoxRef}
        style={{
          border: "1px solid #ddd",
          borderRadius: 6,
          overflowX: "auto",
          overflowY: "hidden",
          background: "#fafafa",
        }}
      >
        <div
          style={{
            position: "relative",
            width: totalWidth,
            // TrackRow は absolute なので親がコンテンツ高さを取れない。
            // ruler 24px + 各 row + gap でレーン全体を確保し、2件以上でも
            // overflowY: hidden で潰れないようにする
            minHeight: 24 + Math.max(TRACK_HEIGHT + TRACK_GAP, tracksTotalHeight),
          }}
        >
          <TimeRuler duration={displayDuration} pxPerSec={pxPerSec} />
          <div
            ref={rowsRef}
            style={{
              position: "relative",
              height: tracksTotalHeight,
            }}
          >
            {tracks.map((t, idx) => {
              const info = rowInfos[idx]!;
              const shown = info.shownSpec;
              return (
                <TrackRow
                  key={trackKey(t)}
                  track={t}
                  index={idx}
                  total={tracks.length}
                  top={info.top}
                  rowHeight={info.height}
                  pxPerSec={pxPerSec}
                  onSeek={(time) => setCurrentTime(Math.max(0, Math.min(displayDuration, time)))}
                  onDelete={() => deleteTrack(t)}
                  onMove={(dir) => moveTrack(idx, dir)}
                  onEdit={() => setEditing({ kind: t.kind, id: t.data.id })}
                  onTrim={() => setTrimming({ kind: t.kind, id: t.data.id })}
                  onSpectrogram={t.kind === "audio" ? () => setSpecDialog(t.data.id) : undefined}
                  soloed={activeSolo?.kind === t.kind && activeSolo.id === t.data.id}
                  onSolo={() =>
                    setSolo((cur) =>
                      cur && cur.kind === t.kind && cur.id === t.data.id
                        ? null
                        : { kind: t.kind, id: t.data.id },
                    )
                  }
                  onLensHover={
                    shown && !playbackLens
                      ? (h) => setLens(h ? { ...h, audioId: t.data.id } : null)
                      : undefined
                  }
                  lensProjT={
                    shown
                      ? playbackLens
                        ? currentTime
                        : lens?.audioId === t.data.id
                          ? lens.projT
                          : null
                      : null
                  }
                  attachRef={(el) => {
                    if (el) mediaRefs.current.set(trackKey(t), el);
                    else mediaRefs.current.delete(trackKey(t));
                  }}
                  spectrogram={
                    shown && (
                      <SpectrogramStrip
                        spec={shown.spec}
                        mode={shown.mode}
                        audio={shown.audio}
                        pxPerSec={pxPerSec}
                        viewportLeft={viewport.left}
                        viewportWidth={viewport.width}
                        top={TRACK_HEIGHT + 2}
                        height={SPECTROGRAM_STRIP_HEIGHT}
                      />
                    )
                  }
                />
              );
            })}
            {tracks.length === 0 && (
              <p style={{ padding: "1rem", color: "#666" }}>動画または音声を追加してください。</p>
            )}
          </div>
          <Playhead time={currentTime} pxPerSec={pxPerSec} height={tracksTotalHeight + 24} />
        </div>
      </div>

      {editingTrack && (
        <MediaEditDialog
          target={editingTrack}
          others={tracks.filter(
            (t) => !(t.kind === editingTrack.kind && t.data.id === editingTrack.data.id),
          )}
          onClose={() => setEditing(null)}
          onApply={(timing) =>
            updateTiming({ kind: editingTrack.kind, id: editingTrack.data.id }, timing)
          }
        />
      )}
      {trimmingTrack && (
        <MediaTrimDialog
          target={trimmingTrack}
          onClose={() => setTrimming(null)}
          onApply={(timing) =>
            updateTiming({ kind: trimmingTrack.kind, id: trimmingTrack.data.id }, timing)
          }
        />
      )}
      {specDialogAudio && (
        <ModalShell
          title={`CQT Spectrogram: ${specDialogAudio.name}`}
          onClose={() => setSpecDialog(null)}
        >
          <SpectrogramDialogBody
            projectId={data.id}
            audio={specDialogAudio}
            view={specViews[specDialogAudio.id] ?? null}
            onChangeView={(v) =>
              setSpecViews((prev) => ({ ...prev, [specDialogAudio.id]: v ?? undefined }))
            }
            onCreate={(p) => createSpectrogram(specDialogAudio.id, p)}
            onDelete={(specId) => deleteSpectrogram(specDialogAudio.id, specId)}
          />
        </ModalShell>
      )}
      {!playbackLens && lens && lensTarget && (
        <HarmonicLens
          spec={lensTarget.spec}
          audio={lensTarget.audio}
          projT={lens.projT}
          yRatio={lens.yRatio}
          anchorX={lens.clientX}
          anchorY={lens.clientY}
        />
      )}
      {playbackLens && (
        <PlaybackLensBar
          tracks={tracks}
          rowInfos={rowInfos}
          currentTime={currentTime}
          isSoloedOut={isSoloedOut}
        />
      )}
    </div>
  );
}

// 再生位置レンズ: 表示中の各 spectrogram を再生ヘッド時刻でスライスし、画面下部に
// 横並びで置く。以前は各レンズを再生ヘッドの座標に fixed 配置していたため縦に折り
// 重なって読めなかった。solo 中は対象 track だけ出す
function PlaybackLensBar({
  tracks,
  rowInfos,
  currentTime,
  isSoloedOut,
}: {
  tracks: Track[];
  rowInfos: { top: number; height: number; shownSpec: ShownSpec | null }[];
  currentTime: number;
  isSoloedOut: (t: Track) => boolean;
}) {
  const shown = rowInfos
    .map((info, idx) => ({ info, track: tracks[idx]! }))
    .filter(({ info, track }) => info.shownSpec && !isSoloedOut(track));
  if (shown.length === 0) return null;
  return (
    <div
      style={{
        position: "fixed",
        left: 0,
        right: 0,
        bottom: 0,
        display: "flex",
        flexWrap: "wrap",
        justifyContent: "center",
        gap: 8,
        padding: 8,
        background: "rgba(0,0,0,0.55)",
        zIndex: 50,
        pointerEvents: "none",
      }}
    >
      {shown.map(({ info, track }) => (
        <HarmonicLens
          key={trackKey(track)}
          placement="inline"
          title={`[${track.kind === "video" ? "V" : "A"}] ${track.data.name}`}
          spec={info.shownSpec!.spec}
          audio={info.shownSpec!.audio}
          projT={currentTime}
          yRatio={null}
        />
      ))}
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
  const mediaT = item.srcStartSec + ((projTime - item.projStartSec) / dProj) * dSrc;
  if (Math.abs(el.currentTime - mediaT) > SYNC_DRIFT_TOLERANCE) {
    el.currentTime = mediaT;
  }
  // browser は negative playbackRate 不可なので逆再生は frame seek だけで preview する
  if (rate <= 0) {
    if (!el.paused) el.pause();
    return;
  }
  el.playbackRate = Math.min(16, Math.max(0.0625, rate));
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
  const step = chooseStep(pxPerSec, duration);
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

// 間隔は最低 60px (label が読める)、tick 数は MAX_TICKS 以下に抑える。
// 長尺 (>1h など) で 1s step が大量 DOM を作るのを防ぐ
function chooseStep(pxPerSec: number, duration: number): number {
  const candidates = [1, 2, 5, 10, 30, 60, 120, 300, 600, 1800, 3600];
  const MAX_TICKS = 1000;
  for (const c of candidates) {
    if (c * pxPerSec >= 60 && duration / c <= MAX_TICKS) return c;
  }
  return 3600;
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

const trackButtonStyle: CSSProperties = {
  background: "rgba(0,0,0,0.45)",
  border: "none",
  color: "white",
  cursor: "pointer",
  fontSize: 11,
  padding: "0 6px",
  borderRadius: 3,
  lineHeight: "16px",
};

function TrackRow({
  track,
  index,
  total,
  top,
  rowHeight,
  pxPerSec,
  onSeek,
  onDelete,
  onMove,
  onEdit,
  onTrim,
  onSpectrogram,
  soloed,
  onSolo,
  onLensHover,
  lensProjT,
  attachRef,
  spectrogram,
}: {
  track: Track;
  index: number;
  total: number;
  top: number;
  rowHeight: number;
  pxPerSec: number;
  onSeek: (time: number) => void;
  onDelete: () => void;
  onMove: (direction: -1 | 1) => void;
  onEdit: () => void;
  onTrim: () => void;
  onSpectrogram?: () => void;
  soloed: boolean;
  onSolo: () => void;
  onLensHover?: (h: LensHover | null) => void;
  lensProjT?: number | null;
  attachRef: (el: HTMLMediaElement | null) => void;
  spectrogram?: ReactNode;
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

  const color = track.kind === "video" ? "#3b82f6" : "#10b981";

  return (
    <div
      style={{
        position: "absolute",
        top,
        left: 0,
        right: 0,
        height: rowHeight,
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
        onPointerMove={
          onLensHover
            ? (e) => {
                const bounds = (
                  e.currentTarget.parentElement as HTMLDivElement
                ).getBoundingClientRect();
                const yIn = e.clientY - bounds.top - (TRACK_HEIGHT + 2);
                onLensHover({
                  projT: (e.clientX - bounds.left) / pxPerSec,
                  yRatio:
                    yIn >= 0 && yIn < SPECTROGRAM_STRIP_HEIGHT
                      ? yIn / SPECTROGRAM_STRIP_HEIGHT
                      : null,
                  clientX: e.clientX,
                  clientY: e.clientY,
                });
              }
            : undefined
        }
        onPointerLeave={onLensHover ? () => onLensHover(null) : undefined}
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
      {lensProjT != null && (
        <div
          style={{
            position: "absolute",
            left: lensProjT * pxPerSec,
            top: 0,
            width: 1,
            height: rowHeight,
            background: "rgba(255,255,255,0.8)",
            pointerEvents: "none",
          }}
        />
      )}
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
        <div style={{ opacity: 0.85, fontSize: 10, textAlign: "right" }}>
          {formatTime(item.durationSec)} / {speed.toFixed(2)}x{reversed ? " (逆)" : ""}
        </div>
        {track.kind === "video" && (
          <ThumbnailStrip video={item as VideoItem} pxPerSec={pxPerSec} trackWidth={width} />
        )}
      </div>
      {spectrogram}
      <div
        style={{
          position: "sticky",
          left: 4,
          zIndex: 4,
          width: "fit-content",
          maxWidth: 280,
          background: soloed ? "rgba(255,244,214,0.96)" : "rgba(250,250,250,0.94)",
          border: `1px solid ${soloed ? "#d97706" : color}`,
          borderRadius: 4,
          padding: "1px 4px 2px",
        }}
      >
        <span
          title={item.name}
          style={{
            display: "block",
            fontWeight: 600,
            fontSize: 12,
            color,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            maxWidth: 272,
          }}
        >
          [{track.kind === "video" ? "V" : "A"}] {item.name}
        </span>
        <div style={{ display: "flex", gap: 2, marginTop: 2 }}>
          <button
            type="button"
            aria-label={`${item.name} を上に移動`}
            disabled={index === 0}
            onClick={(e) => {
              e.stopPropagation();
              onMove(-1);
            }}
            style={trackButtonStyle}
          >
            ↑
          </button>
          <button
            type="button"
            aria-label={`${item.name} を下に移動`}
            disabled={index === total - 1}
            onClick={(e) => {
              e.stopPropagation();
              onMove(1);
            }}
            style={trackButtonStyle}
          >
            ↓
          </button>
          <button
            type="button"
            aria-label={`${item.name} を編集`}
            onClick={(e) => {
              e.stopPropagation();
              onEdit();
            }}
            style={trackButtonStyle}
          >
            編集
          </button>
          <button
            type="button"
            aria-label={`${item.name} をトリミング`}
            onClick={(e) => {
              e.stopPropagation();
              onTrim();
            }}
            style={trackButtonStyle}
          >
            トリミング
          </button>
          {onSpectrogram && (
            <button
              type="button"
              aria-label={`${item.name} の CQT spectrogram`}
              onClick={(e) => {
                e.stopPropagation();
                onSpectrogram();
              }}
              style={trackButtonStyle}
            >
              CQT
            </button>
          )}
          <button
            type="button"
            aria-label={`${item.name} をソロ再生`}
            aria-pressed={soloed}
            onClick={(e) => {
              e.stopPropagation();
              onSolo();
            }}
            style={
              soloed
                ? { ...trackButtonStyle, background: "#d97706", color: "white" }
                : trackButtonStyle
            }
          >
            ソロ
          </button>
          <button
            type="button"
            aria-label={`${item.name} を削除`}
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            style={trackButtonStyle}
          >
            ×
          </button>
        </div>
      </div>
      {track.kind === "video" ? (
        <video
          ref={attachRef as (el: HTMLVideoElement | null) => void}
          src={(item as VideoItem).streamUrl}
          preload="metadata"
          style={{ display: "none" }}
          aria-hidden="true"
        >
          <track kind="captions" />
        </video>
      ) : (
        <audio
          ref={attachRef as (el: HTMLAudioElement | null) => void}
          preload="metadata"
          style={{ display: "none" }}
          aria-hidden="true"
        >
          {/* timing は transcoded probe 由来なので再生対象も transcoded を優先する */}
          <source src={(item as AudioItem).streamUrl} type="audio/mp4" />
          {(item as AudioItem).rawUrl && (
            <source
              src={(item as AudioItem).rawUrl ?? undefined}
              type={(item as AudioItem).rawContentType ?? undefined}
            />
          )}
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

function TaskList({ tasks }: { tasks: ApiTask[] }) {
  return (
    <section
      aria-label="処理中のタスク"
      style={{
        border: "1px solid #ddd",
        borderRadius: 6,
        background: "#f6f8fa",
        padding: "0.5rem 0.75rem",
        margin: "0.5rem 0",
      }}
    >
      <h2 style={{ fontSize: "0.95rem", margin: "0 0 0.4rem 0" }}>処理中のタスク</h2>
      <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: "0.35rem" }}>
        {tasks.map((t) => (
          <TaskRow key={t.id} task={t} />
        ))}
      </ul>
    </section>
  );
}

function TaskRow({ task }: { task: ApiTask }) {
  const kindLabel = task.kind === "video" ? "動画" : task.kind === "audio" ? "音声" : "CQT";
  const statusLabel = (() => {
    switch (task.status) {
      case "pending":
        return "待機中";
      case "running":
        return "処理中…";
      case "failed":
        return "失敗";
      case "succeeded":
        return "完了";
    }
  })();
  const statusColor = (() => {
    switch (task.status) {
      case "running":
        return "#1f6feb";
      case "pending":
        return "#6e7781";
      case "failed":
        return "crimson";
      case "succeeded":
        return "#1a7f37";
    }
  })();
  const fileName = task.fileName;
  return (
    <li
      style={{
        display: "flex",
        alignItems: "center",
        gap: "0.5rem",
        fontSize: "0.85rem",
        flexWrap: "wrap",
      }}
    >
      <span
        style={{
          display: "inline-block",
          minWidth: "2.5rem",
          padding: "0 0.4rem",
          background:
            task.kind === "video" ? "#3b82f6" : task.kind === "audio" ? "#10b981" : "#8b5cf6",
          color: "white",
          borderRadius: 3,
          fontSize: "0.75rem",
          textAlign: "center",
        }}
      >
        {kindLabel}
      </span>
      <span style={{ fontFamily: "monospace", overflow: "hidden", textOverflow: "ellipsis" }}>
        {fileName}
      </span>
      <span style={{ color: statusColor, fontWeight: 600 }}>{statusLabel}</span>
      {task.error && (
        <span
          role="alert"
          style={{
            color: "crimson",
            flexBasis: "100%",
            background: "#fff5f5",
            padding: "0.25rem 0.4rem",
            borderRadius: 3,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {task.error}
        </span>
      )}
    </li>
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

function ModalShell({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      style={{
        position: "fixed",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 100,
      }}
    >
      <button
        type="button"
        aria-label="閉じる (背景)"
        onClick={onClose}
        style={{
          position: "absolute",
          inset: 0,
          background: "rgba(0,0,0,0.45)",
          border: "none",
          padding: 0,
          margin: 0,
          cursor: "pointer",
        }}
      />
      <div
        style={{
          position: "relative",
          background: "white",
          borderRadius: 6,
          padding: "1rem 1.25rem",
          minWidth: 360,
          maxWidth: "min(560px, 92vw)",
          maxHeight: "90vh",
          overflow: "auto",
          boxShadow: "0 6px 24px rgba(0,0,0,0.3)",
        }}
      >
        <header
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: "0.5rem",
          }}
        >
          <h2 style={{ margin: 0, fontSize: 16 }}>{title}</h2>
          <button type="button" aria-label="閉じる" onClick={onClose}>
            ×
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}

type AlignPattern = "same-start" | "same-end" | "after" | "before";

function MediaEditDialog({
  target,
  others,
  onClose,
  onApply,
}: {
  target: Track;
  others: Track[];
  onClose: () => void;
  onApply: (timing: TimingUpdate) => Promise<{ ok: true } | { error: string }>;
}) {
  const t = target.data;
  const SELF_KEY = "__self__";
  const initialAnchorKey = others[0] ? trackKey(others[0]) : SELF_KEY;
  const [anchorKey, setAnchorKey] = useState<string>(initialAnchorKey);
  const [pattern, setPattern] = useState<AlignPattern>("same-start");
  const [scale, setScale] = useState<string>("1");
  const [directStart, setDirectStart] = useState<string>(t.projStartSec.toString());
  const [directEnd, setDirectEnd] = useState<string>(t.projEndSec.toString());
  const [busy, setBusy] = useState<"align" | "direct" | "flip" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const anchorIsSelf = anchorKey === SELF_KEY;
  const anchorTrack = anchorIsSelf
    ? target
    : (others.find((o) => trackKey(o) === anchorKey) ?? null);

  async function submit(timing: TimingUpdate, kind: "align" | "direct" | "flip"): Promise<void> {
    setBusy(kind);
    setError(null);
    const result = await onApply(timing);
    setBusy(null);
    if ("error" in result) setError(result.error);
    else onClose();
  }

  function applyAlign(): void {
    if (!anchorTrack) {
      setError("基準メディアを選択してください");
      return;
    }
    const s = Number(scale);
    if (!Number.isFinite(s) || s <= 0) {
      setError("倍率は正の有限数で指定してください");
      return;
    }
    if (anchorIsSelf && (pattern === "after" || pattern === "before")) {
      setError("自分に対する「直後」「直前」は適用できません");
      return;
    }
    // 配置は visual low/high で決めて向きは projStart/End の swap で保つ
    const a = anchorTrack.data;
    const anchorLow = Math.min(a.projStartSec, a.projEndSec);
    const anchorHigh = Math.max(a.projStartSec, a.projEndSec);
    const newAbsDur = Math.abs(t.projEndSec - t.projStartSec) * s;
    const wasReversed = t.projEndSec < t.projStartSec;
    let newLow: number;
    switch (pattern) {
      case "same-start":
        newLow = anchorLow;
        break;
      case "same-end":
        newLow = anchorHigh - newAbsDur;
        break;
      case "after":
        newLow = anchorHigh;
        break;
      case "before":
        newLow = anchorLow - newAbsDur;
        break;
    }
    const newHigh = newLow + newAbsDur;
    const projStartSec = wasReversed ? newHigh : newLow;
    const projEndSec = wasReversed ? newLow : newHigh;
    if (projStartSec < 0 || projEndSec < 0) {
      setError("結果の projStart/End が負になります");
      return;
    }
    void submit(
      { srcStartSec: t.srcStartSec, srcEndSec: t.srcEndSec, projStartSec, projEndSec },
      "align",
    );
  }

  function applyDirect(): void {
    const ps = Number(directStart);
    const pe = Number(directEnd);
    if (!Number.isFinite(ps) || ps < 0 || !Number.isFinite(pe) || pe < 0) {
      setError("projStart / projEnd は 0 以上の有限数で指定してください");
      return;
    }
    if (ps === pe) {
      setError("projStart と projEnd は同じ値にできません");
      return;
    }
    void submit(
      { srcStartSec: t.srcStartSec, srcEndSec: t.srcEndSec, projStartSec: ps, projEndSec: pe },
      "direct",
    );
  }

  function applyFlip(): void {
    void submit(
      {
        srcStartSec: t.srcStartSec,
        srcEndSec: t.srcEndSec,
        projStartSec: t.projEndSec,
        projEndSec: t.projStartSec,
      },
      "flip",
    );
  }

  return (
    <ModalShell title={`編集: ${t.name}`} onClose={onClose}>
      {error && (
        <p
          role="alert"
          style={{
            color: "crimson",
            background: "#fff5f5",
            border: "1px solid crimson",
            padding: "0.4rem 0.6rem",
            borderRadius: 4,
            margin: "0.5rem 0",
            fontSize: 13,
          }}
        >
          {error}
        </p>
      )}

      <p style={{ fontSize: 12, color: "#555", margin: "0.5rem 0" }}>
        現在: projStart={t.projStartSec.toFixed(3)}s, projEnd={t.projEndSec.toFixed(3)}s （長さ=
        {(t.projEndSec - t.projStartSec).toFixed(3)}s）
      </p>

      <section style={dialogSectionStyle}>
        <h3 style={dialogH3Style}>移動・拡縮</h3>
        <div style={dialogRowStyle}>
          <label style={dialogLabelStyle}>
            基準
            <select
              value={anchorKey}
              onChange={(e) => setAnchorKey(e.target.value)}
              disabled={busy !== null}
            >
              <option value={SELF_KEY}>自分</option>
              {others.map((o) => (
                <option key={trackKey(o)} value={trackKey(o)}>
                  [{o.kind === "video" ? "V" : "A"}] {o.data.name}
                </option>
              ))}
            </select>
          </label>
          <label style={dialogLabelStyle}>
            配置
            <select
              value={pattern}
              onChange={(e) => setPattern(e.target.value as AlignPattern)}
              disabled={busy !== null}
            >
              <option value="same-start">同じ開始時刻</option>
              <option value="same-end">同じ終了時刻</option>
              <option value="after" disabled={anchorIsSelf}>
                終了直後 (自分の開始=基準の終了)
              </option>
              <option value="before" disabled={anchorIsSelf}>
                開始直前 (自分の終了=基準の開始)
              </option>
            </select>
          </label>
          <label style={dialogLabelStyle}>
            倍率
            <input
              type="number"
              step="0.01"
              min="0"
              value={scale}
              onChange={(e) => setScale(e.target.value)}
              disabled={busy !== null}
              style={{ width: 80 }}
            />
          </label>
          <button type="button" onClick={applyAlign} disabled={busy !== null}>
            {busy === "align" ? "適用中…" : "適用"}
          </button>
        </div>
      </section>

      <section style={dialogSectionStyle}>
        <h3 style={dialogH3Style}>直接入力</h3>
        <div style={dialogRowStyle}>
          <label style={dialogLabelStyle}>
            projStartSec
            <input
              type="number"
              step="0.001"
              min="0"
              value={directStart}
              onChange={(e) => setDirectStart(e.target.value)}
              disabled={busy !== null}
              style={{ width: 120 }}
            />
          </label>
          <label style={dialogLabelStyle}>
            projEndSec
            <input
              type="number"
              step="0.001"
              min="0"
              value={directEnd}
              onChange={(e) => setDirectEnd(e.target.value)}
              disabled={busy !== null}
              style={{ width: 120 }}
            />
          </label>
          <button type="button" onClick={applyDirect} disabled={busy !== null}>
            {busy === "direct" ? "適用中…" : "適用"}
          </button>
        </div>
      </section>

      <section style={dialogSectionStyle}>
        <h3 style={dialogH3Style}>時間反転</h3>
        <p style={{ fontSize: 12, color: "#555", margin: "0.25rem 0 0.5rem" }}>
          projStart と projEnd を入れ替える。
        </p>
        <button type="button" onClick={applyFlip} disabled={busy !== null}>
          {busy === "flip" ? "反転中…" : "反転"}
        </button>
      </section>
    </ModalShell>
  );
}

function MediaTrimDialog({
  target,
  onClose,
  onApply,
}: {
  target: Track;
  onClose: () => void;
  onApply: (timing: TimingUpdate) => Promise<{ ok: true } | { error: string }>;
}) {
  const t = target.data;
  const [srcStart, setSrcStart] = useState<string>(t.srcStartSec.toString());
  const [srcEnd, setSrcEnd] = useState<string>(t.srcEndSec.toString());
  const [busy, setBusy] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  async function apply(): Promise<void> {
    const ss = Number(srcStart);
    const se = Number(srcEnd);
    if (!Number.isFinite(ss) || ss < 0 || !Number.isFinite(se) || se < 0) {
      setError("srcStart / srcEnd は 0 以上の有限数で指定してください");
      return;
    }
    if (ss >= se) {
      setError("srcStart は srcEnd より小さい必要があります");
      return;
    }
    if (se > t.durationSec) {
      setError(`srcEnd は durationSec (${t.durationSec}) 以下である必要があります`);
      return;
    }
    setBusy(true);
    setError(null);
    // src 縮小比を proj にも掛けて playback speed を保つ
    const oldSrcDur = t.srcEndSec - t.srcStartSec;
    const ratio = oldSrcDur === 0 ? 1 : (se - ss) / oldSrcDur;
    const newSignedProjDur = (t.projEndSec - t.projStartSec) * ratio;
    const result = await onApply({
      srcStartSec: ss,
      srcEndSec: se,
      projStartSec: t.projStartSec,
      projEndSec: t.projStartSec + newSignedProjDur,
    });
    setBusy(false);
    if ("error" in result) setError(result.error);
    else onClose();
  }

  return (
    <ModalShell title={`トリミング: ${t.name}`} onClose={onClose}>
      {error && (
        <p
          role="alert"
          style={{
            color: "crimson",
            background: "#fff5f5",
            border: "1px solid crimson",
            padding: "0.4rem 0.6rem",
            borderRadius: 4,
            margin: "0.5rem 0",
            fontSize: 13,
          }}
        >
          {error}
        </p>
      )}
      <p style={{ fontSize: 12, color: "#555", margin: "0.5rem 0" }}>
        全長 (durationSec): {t.durationSec.toFixed(3)}s
      </p>
      <div style={dialogRowStyle}>
        <label style={dialogLabelStyle}>
          srcStartSec
          <input
            type="number"
            step="0.001"
            min="0"
            max={t.durationSec}
            value={srcStart}
            onChange={(e) => setSrcStart(e.target.value)}
            disabled={busy}
            style={{ width: 120 }}
          />
        </label>
        <label style={dialogLabelStyle}>
          srcEndSec
          <input
            type="number"
            step="0.001"
            min="0"
            max={t.durationSec}
            value={srcEnd}
            onChange={(e) => setSrcEnd(e.target.value)}
            disabled={busy}
            style={{ width: 120 }}
          />
        </label>
        <button type="button" onClick={apply} disabled={busy}>
          {busy ? "適用中…" : "適用"}
        </button>
      </div>
    </ModalShell>
  );
}

const dialogSectionStyle: CSSProperties = {
  margin: "0.75rem 0",
  paddingTop: "0.75rem",
  borderTop: "1px solid #eee",
};

const dialogH3Style: CSSProperties = {
  margin: "0 0 0.5rem",
  fontSize: 14,
};

const dialogRowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "flex-end",
  gap: "0.6rem",
};

const dialogLabelStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 2,
  fontSize: 12,
  color: "#444",
};
