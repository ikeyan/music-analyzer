// テストプロセス内で共有される SeaweedFS (S3 互換) フィクスチャ。
// 複数のテストファイルが useS3Fixture() を呼んでも container は1度しか起動しない。
// container 自体は testcontainers の Ryuk によりプロセス終了時に自動回収される
import { beforeAll, beforeEach } from "bun:test";
import pMap from "p-map";
import { GenericContainer, Wait } from "testcontainers";
import { SEAWEEDFS_IMAGE } from "../test-images";

const S3_USER = "s3admin";
const S3_PASSWORD = "s3admin-secret";
const TEST_BUCKET = "music-analyzer-test";
const STARTUP_TIMEOUT_MS = 120_000;
const CLEAR_BUCKET_CONCURRENCY = 16;

let initPromise: Promise<void> | null = null;

async function init(): Promise<void> {
  const container = await new GenericContainer(SEAWEEDFS_IMAGE)
    .withExposedPorts(8333)
    .withEnvironment({ AWS_ACCESS_KEY_ID: S3_USER, AWS_SECRET_ACCESS_KEY: S3_PASSWORD })
    .withCommand(["mini", "-dir=/data", `-bucket=${TEST_BUCKET}`])
    .withWaitStrategy(Wait.forLogMessage(`created bucket ${TEST_BUCKET}`))
    .withStartupTimeout(STARTUP_TIMEOUT_MS)
    .start();

  process.env.S3_ENDPOINT = `http://${container.getHost()}:${container.getMappedPort(8333)}`;
  process.env.S3_REGION = "us-east-1";
  process.env.S3_ACCESS_KEY_ID = S3_USER;
  process.env.S3_SECRET_ACCESS_KEY = S3_PASSWORD;
  process.env.S3_BUCKET = TEST_BUCKET;

  // env 反映後にシングルトンを作り直させる
  const { resetS3ForTest } = await import("../lib/s3");
  resetS3ForTest();
}

async function ensureS3Fixture(): Promise<void> {
  if (!initPromise) initPromise = init();
  await initPromise;
}

// バケット内の全オブジェクトを削除する。テスト間の干渉を切るため beforeEach から呼ぶ
async function clearS3Bucket(): Promise<void> {
  const { getS3 } = await import("../lib/s3");
  const s3 = getS3();
  let token: string | undefined;
  do {
    const result = await s3.list({ continuationToken: token });
    const keys = (result.contents ?? []).flatMap((o) => (o.key ? [o.key] : []));
    await pMap(keys, (k) => s3.delete(k), { concurrency: CLEAR_BUCKET_CONCURRENCY });
    token = result.isTruncated ? result.nextContinuationToken : undefined;
  } while (token);
}

export function useS3Fixture(): void {
  beforeAll(ensureS3Fixture, STARTUP_TIMEOUT_MS);
  beforeEach(clearS3Bucket);
}
