#!/usr/bin/env bun
// Dockerfile / Dockerfile.app と同じ static-ffmpeg image から ffmpeg / ffprobe を
// <out>/ に置く。session-start hook と CI が共有する
import { $ } from "bun";
import { parseArgs } from "node:util";

export const FFMPEG_IMAGE = "mwader/static-ffmpeg:7.1.1";
const CONTAINER = "music-analyzer-ffmpeg-extract";

export async function installFfmpeg(outDir: string): Promise<void> {
  await $`docker pull ${FFMPEG_IMAGE}`.quiet();
  await $`docker rm -f ${CONTAINER}`.quiet().nothrow();
  await $`docker create --name ${CONTAINER} ${FFMPEG_IMAGE}`.quiet();
  await $`docker cp ${CONTAINER}:/ffmpeg ${outDir}/ffmpeg`;
  await $`docker cp ${CONTAINER}:/ffprobe ${outDir}/ffprobe`;
  await $`docker rm ${CONTAINER}`.quiet();
  await $`chmod +x ${outDir}/ffmpeg ${outDir}/ffprobe`;
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { out: { type: "string" } }, strict: true });
  if (!values.out) throw new Error("--out <dir> required");
  await installFfmpeg(values.out);
}
