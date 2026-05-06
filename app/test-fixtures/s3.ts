// テストプロセス内で共有される MinIO フィクスチャ。
// 複数のテストファイルが useS3Fixture() を呼んでも MinIO container は1度しか起動しない。
// container 自体は testcontainers の Ryuk によりプロセス終了時に自動回収される
import { beforeAll, beforeEach } from "bun:test";
import { GenericContainer, Wait } from "testcontainers";
import { MINIO_IMAGE } from "../test-images";

const MINIO_USER = "minioadmin";
const MINIO_PASSWORD = "minioadmin";
const TEST_BUCKET = "music-analyzer-test";
const STARTUP_TIMEOUT_MS = 120_000;

let initPromise: Promise<void> | null = null;

async function init(): Promise<void> {
  // minio image にも Bun の S3Client にも bucket 作成 API がないので起動前にディレクトリを作る
  const container = await new GenericContainer(MINIO_IMAGE)
    .withExposedPorts(9000)
    .withEnvironment({
      MINIO_ROOT_USER: MINIO_USER,
      MINIO_ROOT_PASSWORD: MINIO_PASSWORD,
    })
    .withEntrypoint(["/bin/sh", "-c"])
    .withCommand([`mkdir -p /data/${TEST_BUCKET} && exec minio server /data --address :9000`])
    .withWaitStrategy(Wait.forLogMessage(/API:/))
    .withStartupTimeout(STARTUP_TIMEOUT_MS)
    .start();

  process.env.S3_ENDPOINT = `http://${container.getHost()}:${container.getMappedPort(9000)}`;
  process.env.S3_REGION = "us-east-1";
  process.env.S3_ACCESS_KEY_ID = MINIO_USER;
  process.env.S3_SECRET_ACCESS_KEY = MINIO_PASSWORD;
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
    for (const o of result.contents ?? []) {
      if (o.key) await s3.delete(o.key);
    }
    token = result.isTruncated ? result.nextContinuationToken : undefined;
  } while (token);
}

export function useS3Fixture(): void {
  beforeAll(ensureS3Fixture, STARTUP_TIMEOUT_MS);
  beforeEach(clearS3Bucket);
}
