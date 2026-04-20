import { S3Client } from "bun";

const globalForS3 = globalThis as unknown as {
  s3?: S3Client;
};

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
  if (!globalForS3.s3) {
    globalForS3.s3 = createS3Client();
  }
  return globalForS3.s3;
}

export function resetS3ForTest(): void {
  globalForS3.s3 = undefined;
}
