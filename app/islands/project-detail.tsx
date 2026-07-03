import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
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
// 動画表示 ON の video 行に足す monitor 帯の高さ
const VIDEO_STRIP_HEIGHT = 140;

// ソロ再生中の clip を脈動する光輪で強調する
const SOLO_HALO_KEYFRAMES = `@keyframes soloHalo {
  0%, 100% { box-shadow: 0 0 0 2px #d97706, 0 0 6px 2px rgba(217,119,6,0.5); }
  50% { box-shadow: 0 0 0 2px #f59e0b, 0 0 18px 6px rgba(245,158,11,0.9); }
}`;
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
  // mute: 指定 track を無音化。solo と mute が両方付いた track は solo が勝つ (鳴る)
  const [muted, setMuted] = useState<ReadonlySet<string>>(() => new Set());
  // 動画を行の下に表示する video id 集合 (CQT 表示と同様の行追加)
  const [shownVideos, setShownVideos] = useState<ReadonlySet<string>>(() => new Set());
  // 全体ボリューム (0..1) と再生速度 (倍率)
  const [volume, setVolume] = useState(1);
  const [speed, setSpeed] = useState(1);
  // CQT / 動画 band の行ごとの高さ override (trackKey → px)
  const [bandHeights, setBandHeights] = useState<ReadonlyMap<string, number>>(() => new Map());
  const rowsRef = useRef<HTMLDivElement | null>(null);

  // 表示状態 (specViews) と再生位置レンズの ON/OFF を project 単位で localStorage に保存。
  // hydration mismatch を避けるため初期値は空で mount 後に読み込む。save effect を load より
  // 先に定義することで、mount commit では restoredRef=false で save が skip され、初期空値で
  // 保存データを潰さない (load が state を当てた次の commit から保存が効く)
  const viewsKey = `cqtViews:${data.id}`;
  const lensKey = `cqtPlaybackLens:${data.id}`;
  const autoScrollKey = `cqtAutoScroll:${data.id}`;
  const videoShownKey = `videoShown:${data.id}`;
  const mixKey = `mix:${data.id}`;
  const bandHeightsKey = `bandHeights:${data.id}`;
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
    if (restoredRef.current) saveLocal(videoShownKey, [...shownVideos]);
  }, [videoShownKey, shownVideos]);
  useEffect(() => {
    if (restoredRef.current) saveLocal(mixKey, { volume, speed });
  }, [mixKey, volume, speed]);
  useEffect(() => {
    if (restoredRef.current) saveLocal(bandHeightsKey, [...bandHeights]);
  }, [bandHeightsKey, bandHeights]);
  useEffect(() => {
    setSpecViews(loadLocal(viewsKey, {} as Record<string, SpectrogramSelection | undefined>));
    setPlaybackLens(loadLocal(lensKey, false));
    setAutoScroll(loadLocal(autoScrollKey, false));
    setShownVideos(new Set(loadLocal<string[]>(videoShownKey, [])));
    const mix = loadLocal(mixKey, { volume: 1, speed: 1 });
    setVolume(mix.volume);
    setSpeed(mix.speed);
    setBandHeights(new Map(loadLocal<[string, number][]>(bandHeightsKey, [])));
    restoredRef.current = true;
  }, [viewsKey, lensKey, autoScrollKey, videoShownKey, mixKey, bandHeightsKey]);

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
  // 音を出さない track: solo 中は solo 対象以外、solo 無しなら mute された track。
  // solo 対象は mute されていても solo が勝って鳴る (isSoloedOut=false のまま)
  const isSilenced = useCallback(
    (t: Track) => isSoloedOut(t) || (activeSolo === null && muted.has(trackKey(t))),
    [isSoloedOut, activeSolo, muted],
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
        const next = prev + dt * speed;
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
  }, [playing, playEnd, speed]);

  // 自動スクロール: 再生中は currentTime が毎フレーム更新されるので、その度に
  // 再生ヘッドを viewport 中央に置く scrollLeft を書いて連続的に追従する
  useEffect(() => {
    if (!playing || !autoScroll) return;
    const el = scrollBoxRef.current;
    if (!el) return;
    const max = Math.max(0, el.scrollWidth - el.clientWidth);
    el.scrollLeft = Math.max(0, Math.min(max, currentTime * pxPerSec - el.clientWidth / 2));
  }, [playing, autoScroll, currentTime, pxPerSec]);

  // ズーム変更で再生ヘッド (赤線) の画面上の位置が動かないよう scrollLeft を補正する。
  // currentTime は毎フレーム変わるので ref 経由で読み、pxPerSec 変化時だけ走らせる
  const currentTimeRef = useRef(currentTime);
  currentTimeRef.current = currentTime;
  const prevPxRef = useRef(pxPerSec);
  useLayoutEffect(() => {
    const el = scrollBoxRef.current;
    const oldPx = prevPxRef.current;
    prevPxRef.current = pxPerSec;
    if (!el || oldPx === pxPerSec) return;
    const max = Math.max(0, el.scrollWidth - el.clientWidth);
    el.scrollLeft = Math.max(
      0,
      Math.min(max, el.scrollLeft + currentTimeRef.current * (pxPerSec - oldPx)),
    );
  }, [pxPerSec]);

  useEffect(() => {
    for (const t of tracks) {
      const key = trackKey(t);
      // unlock 中は play() を pause で abort せず .then の resolve に任せる
      if (unlockingRef.current.has(key)) continue;
      const el = mediaRefs.current.get(key);
      if (!el) continue;
      const silenced = isSilenced(t);
      // audio の無音 track は止める。video は無音でも再生し続けて映像を見せる (frame 追従)
      if (silenced && t.kind === "audio") {
        if (!el.paused) el.pause();
        continue;
      }
      syncMediaElement(el, t.data, currentTime, playing, silenced, volume, speed, () => {
        setPlaying(false);
        setError(
          "ブラウザのautoplay制限で再生できませんでした。もう一度再生ボタンを押してください。",
        );
      });
    }
  }, [tracks, currentTime, playing, isSilenced, volume, speed]);

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
    // 末尾まで再生済み (currentTime==playEnd) なら先頭から再生し直す。
    // そのまま start すると tick が即 next>=playEnd で停止してしまう
    const from = currentTime >= playEnd ? 0 : currentTime;
    if (from !== currentTime) setCurrentTime(from);
    let blocked = false;
    for (const t of tracks) {
      const key = trackKey(t);
      const el = mediaRefs.current.get(key);
      if (!el) continue;
      const projLow = Math.min(t.data.projStartSec, t.data.projEndSec);
      const projHigh = Math.max(t.data.projStartSec, t.data.projEndSec);
      const inWindow = from >= projLow && from <= projHigh;
      const silenced = isSilenced(t);
      // video は無音でも映像を見せるため再生し続ける。audio の無音は鳴らさない
      const keepPlaying = inWindow && !(t.kind === "audio" && silenced);
      const wasMuted = el.muted;
      if (!keepPlaying) {
        el.muted = true;
        unlockingRef.current.add(key);
      } else {
        el.muted = t.kind === "video" ? silenced : false;
      }
      const promise = el.play();
      if (promise && typeof promise.then === "function") {
        promise
          .then(() => {
            if (!keepPlaying) {
              el.pause();
              el.muted = wasMuted;
              unlockingRef.current.delete(key);
            }
          })
          .catch((err: unknown) => {
            if (!keepPlaying) {
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
      } else if (!keepPlaying) {
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
    shownVideo: boolean;
    /** CQT / 動画 band の高さ (band が無い行は 0) */
    bandHeight: number;
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
      const shownVideo = t.kind === "video" && shownVideos.has(t.data.id);
      const hasBand = shownSpec !== null || shownVideo;
      const defaultBand = shownSpec ? SPECTROGRAM_STRIP_HEIGHT : VIDEO_STRIP_HEIGHT;
      const bandHeight = hasBand ? (bandHeights.get(trackKey(t)) ?? defaultBand) : 0;
      const extra = hasBand ? bandHeight + 4 : 0;
      const info = { top, height: TRACK_HEIGHT + extra, shownSpec, shownVideo, bandHeight };
      top += info.height + TRACK_GAP;
      return info;
    });
  }, [tracks, specViews, shownVideos, bandHeights]);
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

  // hover 中の CQT 上のカーソル周波数。再生位置レンズ pane 側で同じ周波数に白線を出す用。
  // yRatio=0 が上端 (最高周波数)、bin = (1-yRatio)*bins なので f = fmin*2^((1-yRatio)*octaves)
  const hoverFreqHz =
    lens && lens.yRatio !== null && lensTarget
      ? lensTarget.spec.fminHz * 2 ** ((1 - lens.yRatio) * lensTarget.spec.octaves)
      : null;

  return (
    <div>
      <style>{SOLO_HALO_KEYFRAMES}</style>
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
          title="全 media の音量"
        >
          🔊
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={volume}
            onChange={(e) => setVolume(Number(e.target.value))}
            style={{ width: 80 }}
          />
        </label>
        <label
          style={{ display: "flex", alignItems: "center", gap: "0.3rem", fontSize: 13 }}
          title="再生速度 (0.25〜4x)"
        >
          速度
          <input
            type="range"
            min={0.25}
            max={4}
            step={0.05}
            value={speed}
            onChange={(e) => setSpeed(Number(e.target.value))}
            style={{ width: 90 }}
          />
          <span style={{ fontVariantNumeric: "tabular-nums" }}>{speed.toFixed(2)}x</span>
        </label>
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
                  showVideo={t.kind === "video" ? shownVideos.has(t.data.id) : undefined}
                  onToggleVideo={
                    t.kind === "video"
                      ? () =>
                          setShownVideos((cur) => {
                            const n = new Set(cur);
                            if (n.has(t.data.id)) n.delete(t.data.id);
                            else n.add(t.data.id);
                            return n;
                          })
                      : undefined
                  }
                  soloed={activeSolo?.kind === t.kind && activeSolo.id === t.data.id}
                  soloActive={activeSolo !== null}
                  onSolo={() =>
                    setSolo((cur) =>
                      cur && cur.kind === t.kind && cur.id === t.data.id
                        ? null
                        : { kind: t.kind, id: t.data.id },
                    )
                  }
                  muted={muted.has(trackKey(t))}
                  onMute={() =>
                    setMuted((cur) => {
                      const n = new Set(cur);
                      if (n.has(trackKey(t))) n.delete(trackKey(t));
                      else n.add(trackKey(t));
                      return n;
                    })
                  }
                  bandHeight={info.bandHeight}
                  onBandResize={
                    info.shownSpec || info.shownVideo
                      ? (h) =>
                          setBandHeights((cur) => {
                            const n = new Map(cur);
                            n.set(trackKey(t), h);
                            return n;
                          })
                      : undefined
                  }
                  onLensHover={
                    shown ? (h) => setLens(h ? { ...h, audioId: t.data.id } : null) : undefined
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
                        height={info.bandHeight}
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
        <PlaybackLensPane
          tracks={tracks}
          rowInfos={rowInfos}
          currentTime={currentTime}
          isSoloedOut={isSoloedOut}
          hoverFreqHz={hoverFreqHz}
          storageKey={`cqtLensPane:${data.id}`}
        />
      )}
    </div>
  );
}

type PaneGeo = { x: number; y: number; w: number; h: number };
const LENS_PANE_MIN_W = 220;
const LENS_PANE_MIN_H = 160;

function defaultPaneGeo(): PaneGeo {
  const vw = typeof window === "undefined" ? 1200 : window.innerWidth;
  const vh = typeof window === "undefined" ? 800 : window.innerHeight;
  const w = Math.min(720, vw - 24);
  const h = Math.min(300, Math.round(vh * 0.4));
  return { x: Math.max(12, (vw - w) / 2), y: vh - h - 16, w, h };
}

// 再生位置レンズ: 表示中の各 spectrogram を再生ヘッド時刻でスライスして 1 つの pane に
// 横並びで置く。pane はドラッグで移動・右下ハンドルでリサイズでき、中身は overflow:auto
// なので全 media に届く。solo 中は対象 track だけ出す
// hoverFreqHz を spec の縦位置 (yRatio, 0=上端) に変換。範囲外なら null
function freqToYRatio(spec: ApiSpectrogram, freqHz: number): number | null {
  const yr = 1 - Math.log2(freqHz / spec.fminHz) / spec.octaves;
  return yr >= 0 && yr <= 1 ? yr : null;
}

const LENS_PANE_HEADER_H = 26;

function PlaybackLensPane({
  tracks,
  rowInfos,
  currentTime,
  isSoloedOut,
  hoverFreqHz,
  storageKey,
}: {
  tracks: Track[];
  rowInfos: { top: number; height: number; shownSpec: ShownSpec | null }[];
  currentTime: number;
  isSoloedOut: (t: Track) => boolean;
  hoverFreqHz: number | null;
  storageKey: string;
}) {
  const [geo, setGeo] = useState<PaneGeo>(() => loadLocal(storageKey, defaultPaneGeo()));
  useEffect(() => {
    saveLocal(storageKey, geo);
  }, [storageKey, geo]);
  // 中身を横に並べた自然幅 (max-content) を測り、pane 幅の最大値にする
  const innerRef = useRef<HTMLDivElement | null>(null);
  const [contentW, setContentW] = useState<number | null>(null);
  useEffect(() => {
    const el = innerRef.current;
    if (!el) return;
    const measure = () => setContentW(el.offsetWidth + 18);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const drag = useRef<{ mode: "move" | "resize"; sx: number; sy: number; orig: PaneGeo } | null>(
    null,
  );
  const onDown = (mode: "move" | "resize") => (e: ReactPointerEvent) => {
    drag.current = { mode, sx: e.clientX, sy: e.clientY, orig: geo };
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
  };
  const onMove = (e: ReactPointerEvent): void => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.sx;
    const dy = e.clientY - d.sy;
    if (d.mode === "move") setGeo({ ...d.orig, x: d.orig.x + dx, y: d.orig.y + dy });
    else {
      const maxW = contentW ?? Number.POSITIVE_INFINITY;
      setGeo({
        ...d.orig,
        w: Math.min(maxW, Math.max(LENS_PANE_MIN_W, d.orig.w + dx)),
        h: Math.max(LENS_PANE_MIN_H, d.orig.h + dy),
      });
    }
  };
  const onUp = (e: ReactPointerEvent): void => {
    drag.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {}
  };

  const shown = rowInfos
    .map((info, idx) => ({ info, track: tracks[idx]! }))
    .filter(({ info, track }) => info.shownSpec && !isSoloedOut(track));
  if (shown.length === 0) return null;
  // pane 幅は中身幅を超えない。中身の縦幅は pane 高さから header/padding を引いて充填する
  const paneW = contentW != null ? Math.min(geo.w, contentW) : geo.w;
  const lensHeight = Math.max(120, geo.h - LENS_PANE_HEADER_H - 16 - 44);
  return (
    <div
      style={{
        position: "fixed",
        left: geo.x,
        top: geo.y,
        width: paneW,
        height: geo.h,
        maxWidth: contentW ?? undefined,
        display: "flex",
        flexDirection: "column",
        background: "rgba(10,10,12,0.92)",
        border: "1px solid #555",
        borderRadius: 6,
        zIndex: 60,
        boxShadow: "0 6px 24px rgba(0,0,0,0.5)",
      }}
    >
      <div
        onPointerDown={onDown("move")}
        onPointerMove={onMove}
        onPointerUp={onUp}
        style={{
          cursor: "move",
          touchAction: "none",
          userSelect: "none",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "3px 8px",
          color: "#ddd",
          fontSize: 12,
          borderBottom: "1px solid #555",
        }}
      >
        <span style={{ fontVariantNumeric: "tabular-nums" }}>
          再生位置レンズ t={currentTime.toFixed(2)}s
        </span>
        <span style={{ opacity: 0.7 }}>{shown.length} media · ドラッグで移動 / 右下で拡縮</span>
      </div>
      <div style={{ flex: 1, overflow: "auto", padding: 8 }}>
        <div ref={innerRef} style={{ display: "flex", gap: 8, width: "max-content" }}>
          {shown.map(({ info, track }) => (
            <HarmonicLens
              key={trackKey(track)}
              placement="inline"
              fillHeight={lensHeight}
              title={`[${track.kind === "video" ? "V" : "A"}] ${track.data.name}`}
              spec={info.shownSpec!.spec}
              audio={info.shownSpec!.audio}
              projT={currentTime}
              yRatio={hoverFreqHz != null ? freqToYRatio(info.shownSpec!.spec, hoverFreqHz) : null}
            />
          ))}
        </div>
      </div>
      <div
        onPointerDown={onDown("resize")}
        onPointerMove={onMove}
        onPointerUp={onUp}
        aria-hidden="true"
        style={{
          position: "absolute",
          right: 0,
          bottom: 0,
          width: 18,
          height: 18,
          cursor: "nwse-resize",
          touchAction: "none",
          background: "linear-gradient(135deg, transparent 50%, #888 50%)",
          borderBottomRightRadius: 6,
        }}
      />
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
  muted: boolean,
  volume: number,
  speed: number,
  onPlayError?: (err: unknown) => void,
): void {
  const projLow = Math.min(item.projStartSec, item.projEndSec);
  const projHigh = Math.max(item.projStartSec, item.projEndSec);
  const inside = projTime >= projLow && projTime <= projHigh;
  if (!inside) {
    if (!el.paused) el.pause();
    return;
  }
  el.muted = muted;
  el.volume = Math.max(0, Math.min(1, volume));
  const dProj = item.projEndSec - item.projStartSec;
  const dSrc = item.srcEndSec - item.srcStartSec;
  if (dProj === 0 || dSrc === 0) {
    if (!el.paused) el.pause();
    return;
  }
  const rate = (dSrc / dProj) * speed;
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
  showVideo,
  onToggleVideo,
  soloed,
  soloActive,
  onSolo,
  muted,
  onMute,
  bandHeight,
  onBandResize,
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
  showVideo?: boolean;
  onToggleVideo?: () => void;
  soloed: boolean;
  soloActive: boolean;
  onSolo: () => void;
  muted: boolean;
  onMute: () => void;
  bandHeight: number;
  onBandResize?: (h: number) => void;
  onLensHover?: (h: LensHover | null) => void;
  lensProjT?: number | null;
  attachRef: (el: HTMLMediaElement | null) => void;
  spectrogram?: ReactNode;
}) {
  const bandDrag = useRef<{ sy: number; orig: number } | null>(null);
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
          // ソロ再生中に別 track をクリックしたら solo 対象をその track に入れ替える
          if (soloActive && !soloed) onSolo();
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
                  yRatio: yIn >= 0 && yIn < bandHeight ? yIn / bandHeight : null,
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
          boxShadow: soloed
            ? "0 0 0 2px #d97706, 0 0 14px 4px rgba(217,119,6,0.75)"
            : "0 1px 2px rgba(0,0,0,0.15)",
          animation: soloed ? "soloHalo 1.4s ease-in-out infinite" : undefined,
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
      {onBandResize && (
        <div
          aria-hidden="true"
          onPointerDown={(e) => {
            bandDrag.current = { sy: e.clientY, orig: bandHeight };
            e.currentTarget.setPointerCapture(e.pointerId);
            e.preventDefault();
            e.stopPropagation();
          }}
          onPointerMove={(e) => {
            const d = bandDrag.current;
            if (!d) return;
            onBandResize(Math.max(48, Math.min(600, d.orig + (e.clientY - d.sy))));
          }}
          onPointerUp={(e) => {
            bandDrag.current = null;
            try {
              e.currentTarget.releasePointerCapture(e.pointerId);
            } catch {}
          }}
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: TRACK_HEIGHT + 2 + bandHeight - 4,
            height: 9,
            cursor: "ns-resize",
            zIndex: 5,
            touchAction: "none",
          }}
        />
      )}
      <div
        style={{
          position: "sticky",
          left: 4,
          zIndex: 4,
          width: "fit-content",
          maxWidth: 280,
          background: soloed
            ? "rgba(255,237,190,0.98)"
            : muted
              ? "rgba(236,236,238,0.94)"
              : "rgba(250,250,250,0.94)",
          border: `1.5px solid ${soloed ? "#d97706" : muted ? "#9ca3af" : color}`,
          borderRadius: 4,
          padding: "1px 4px 2px",
          // solo 中は media 名まわりを脈動する光輪で強調する (clip 側だけだと見えづらい)
          boxShadow: soloed ? "0 0 0 2px #f59e0b, 0 0 16px 5px rgba(245,158,11,0.85)" : undefined,
          animation: soloed ? "soloHalo 1.4s ease-in-out infinite" : undefined,
        }}
      >
        <span
          title={item.name}
          style={{
            display: "block",
            fontWeight: soloed ? 700 : 600,
            fontSize: 12,
            color: soloed ? "#b45309" : muted ? "#9ca3af" : color,
            textDecoration: muted && !soloed ? "line-through" : undefined,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            maxWidth: 272,
          }}
        >
          {soloed ? "◉ " : muted ? "🔇 " : ""}[{track.kind === "video" ? "V" : "A"}] {item.name}
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
          {onToggleVideo && (
            <button
              type="button"
              aria-label={`${item.name} の動画表示`}
              aria-pressed={showVideo}
              onClick={(e) => {
                e.stopPropagation();
                onToggleVideo();
              }}
              style={
                showVideo
                  ? { ...trackButtonStyle, background: "#2563eb", color: "white" }
                  : trackButtonStyle
              }
            >
              動画
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
            aria-label={`${item.name} をミュート`}
            aria-pressed={muted}
            onClick={(e) => {
              e.stopPropagation();
              onMute();
            }}
            style={
              muted
                ? { ...trackButtonStyle, background: "#6b7280", color: "white" }
                : trackButtonStyle
            }
          >
            ミュート
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
        // 表示 ON なら行下の monitor 帯に現在フレームを出す。band は絶対配置で縦位置を固定し、
        // 中の video を sticky-left で横スクロールしても画面内に残す。常に mount したまま
        // display で出し分けて、toggle での再 mount (再生位置リセット) を避ける
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: TRACK_HEIGHT + 2,
            height: bandHeight,
            pointerEvents: "none",
            display: showVideo ? "block" : "none",
            zIndex: 3,
          }}
        >
          <video
            ref={attachRef as (el: HTMLVideoElement | null) => void}
            src={(item as VideoItem).streamUrl}
            preload="metadata"
            aria-hidden="true"
            style={{
              position: "sticky",
              left: 4,
              display: "block",
              height: bandHeight,
              width: "auto",
              maxWidth: "60vw",
              borderRadius: 4,
              background: "#000",
              boxShadow: "0 1px 3px rgba(0,0,0,0.3)",
            }}
          >
            <track kind="captions" />
          </video>
        </div>
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
