// API レスポンス用の DTO。Prisma 行をこれに射影してから c.json で返すと、
// bigint が JSON に乗らず Hono RPC の型推論も全フィールドにつく
import type { Audio, Project, Task, Thumbnail, Upload, Video } from "../generated/prisma/client";

export type ApiThumbnail = {
  id: string;
  atSec: number;
  url: string;
  width: number;
  height: number;
};

export type ApiVideo = {
  id: string;
  projectId: string;
  order: number;
  name: string;
  videoKey: string;
  audioKey: string | null;
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  videoBitrate: number | null;
  audioBitrate: number | null;
  sizeBytes: number;
  srcStartSec: number;
  srcEndSec: number;
  projStartSec: number;
  projEndSec: number;
  createdAt: string;
  updatedAt: string;
  streamUrl: string;
  audioUrl: string | null;
  thumbnails: ApiThumbnail[];
};

export type ApiAudio = {
  id: string;
  projectId: string;
  order: number;
  name: string;
  audioKey: string;
  rawKey: string | null;
  rawContentType: string | null;
  durationSec: number;
  sampleRate: number | null;
  channels: number | null;
  bitrate: number | null;
  sizeBytes: number;
  srcStartSec: number;
  srcEndSec: number;
  projStartSec: number;
  projEndSec: number;
  createdAt: string;
  updatedAt: string;
  streamUrl: string;
  rawUrl: string | null;
};

export type ApiProject = {
  id: string;
  userId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
};

export type ApiProjectDetail = ApiProject & {
  videos: ApiVideo[];
  audios: ApiAudio[];
  // pending / running / failed の task。succeeded は Video/Audio に昇格済みなので含めない
  tasks: ApiTask[];
};

export type ApiProjectSummary = ApiProject & {
  videoCount: number;
  audioCount: number;
};

export type ApiUpload = {
  id: string;
  projectId: string;
  kind: "video" | "audio";
  fileName: string;
  contentType: string | null;
  totalBytes: number;
  chunkSize: number;
  totalChunks: number;
  receivedBytes: number;
  status: "pending" | "completed" | "aborted";
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
};

export type ApiTask = {
  id: string;
  projectId: string;
  type: "video_validation" | "audio_validation";
  status: "pending" | "running" | "succeeded" | "failed";
  error: string | null;
  uploadId: string | null;
  // 何のファイルを処理中か UI で表示するため upload を inline する。
  // upload は Task ライフタイムを超えて消えうるので nullable
  upload: { fileName: string; kind: "video" | "audio" } | null;
  videoId: string | null;
  audioId: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

export function toApiThumbnail(projectId: string, videoId: string, t: Thumbnail): ApiThumbnail {
  return {
    id: t.id,
    atSec: t.atSec,
    url: `/api/projects/${projectId}/videos/${videoId}/thumbnails/${t.id}`,
    width: t.width,
    height: t.height,
  };
}

export function toApiVideo(v: Video & { thumbnails: Thumbnail[] }): ApiVideo {
  return {
    id: v.id,
    projectId: v.projectId,
    order: v.order,
    name: v.name,
    videoKey: v.videoKey,
    audioKey: v.audioKey,
    durationSec: v.durationSec,
    width: v.width,
    height: v.height,
    fps: v.fps,
    videoBitrate: v.videoBitrate,
    audioBitrate: v.audioBitrate,
    sizeBytes: Number(v.sizeBytes),
    srcStartSec: v.srcStartSec,
    srcEndSec: v.srcEndSec,
    projStartSec: v.projStartSec,
    projEndSec: v.projEndSec,
    createdAt: v.createdAt.toISOString(),
    updatedAt: v.updatedAt.toISOString(),
    streamUrl: `/api/projects/${v.projectId}/videos/${v.id}/stream`,
    audioUrl: v.audioKey ? `/api/projects/${v.projectId}/videos/${v.id}/audio` : null,
    thumbnails: v.thumbnails.map((t) => toApiThumbnail(v.projectId, v.id, t)),
  };
}

export function toApiAudio(a: Audio): ApiAudio {
  return {
    id: a.id,
    projectId: a.projectId,
    order: a.order,
    name: a.name,
    audioKey: a.audioKey,
    rawKey: a.rawKey,
    rawContentType: a.rawContentType,
    durationSec: a.durationSec,
    sampleRate: a.sampleRate,
    channels: a.channels,
    bitrate: a.bitrate,
    sizeBytes: Number(a.sizeBytes),
    srcStartSec: a.srcStartSec,
    srcEndSec: a.srcEndSec,
    projStartSec: a.projStartSec,
    projEndSec: a.projEndSec,
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
    streamUrl: `/api/projects/${a.projectId}/audios/${a.id}/stream`,
    rawUrl: a.rawKey ? `/api/projects/${a.projectId}/audios/${a.id}/raw` : null,
  };
}

export function toApiProject(p: Project): ApiProject {
  return {
    id: p.id,
    userId: p.userId,
    name: p.name,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

export function toApiProjectDetail(
  p: Project & {
    videos: (Video & { thumbnails: Thumbnail[] })[];
    audios: Audio[];
    tasks: (Task & { upload: { fileName: string; kind: string } | null })[];
  },
): ApiProjectDetail {
  return {
    ...toApiProject(p),
    videos: p.videos.map(toApiVideo),
    audios: p.audios.map(toApiAudio),
    tasks: p.tasks.map(toApiTask),
  };
}

export function toApiProjectSummary(
  p: Project & { _count: { videos: number; audios: number } },
): ApiProjectSummary {
  return {
    ...toApiProject(p),
    videoCount: p._count.videos,
    audioCount: p._count.audios,
  };
}

export function toApiUpload(u: Upload): ApiUpload {
  return {
    id: u.id,
    projectId: u.projectId,
    kind: u.kind as "video" | "audio",
    fileName: u.fileName,
    contentType: u.contentType,
    totalBytes: Number(u.totalBytes),
    chunkSize: u.chunkSize,
    totalChunks: u.totalChunks,
    receivedBytes: Number(u.receivedBytes),
    status: u.status as "pending" | "completed" | "aborted",
    expiresAt: u.expiresAt.toISOString(),
    createdAt: u.createdAt.toISOString(),
    updatedAt: u.updatedAt.toISOString(),
  };
}

export function toApiTask(
  t: Task & { upload?: { fileName: string; kind: string } | null },
): ApiTask {
  return {
    id: t.id,
    projectId: t.projectId,
    type: t.type as "video_validation" | "audio_validation",
    status: t.status as "pending" | "running" | "succeeded" | "failed",
    error: t.error,
    uploadId: t.uploadId,
    upload: t.upload
      ? { fileName: t.upload.fileName, kind: t.upload.kind as "video" | "audio" }
      : null,
    videoId: t.videoId,
    audioId: t.audioId,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
    startedAt: t.startedAt?.toISOString() ?? null,
    finishedAt: t.finishedAt?.toISOString() ?? null,
  };
}
