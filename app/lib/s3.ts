import { S3Client } from "bun";

declare global {
  // dev で HMR/再 import 時に S3Client を使い回すための単一スロット
  // eslint-disable-next-line no-var
  var __musicAnalyzerS3: S3Client | undefined;
}

function createS3Client(): S3Client {
  const accessKeyId = process.env.S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
  const bucket = process.env.S3_BUCKET;

  if (!accessKeyId || !secretAccessKey || !bucket) {
    throw new Error(
      "Missing S3 configuration: S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, and S3_BUCKET are required",
    );
  }

  return new S3Client({
    endpoint: process.env.S3_ENDPOINT,
    region: process.env.S3_REGION ?? "us-east-1",
    accessKeyId,
    secretAccessKey,
    bucket,
  });
}

export function getS3(): S3Client {
  if (!globalThis.__musicAnalyzerS3) {
    globalThis.__musicAnalyzerS3 = createS3Client();
  }
  return globalThis.__musicAnalyzerS3;
}

export function resetS3ForTest(): void {
  globalThis.__musicAnalyzerS3 = undefined;
}
