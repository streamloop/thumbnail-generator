import { S3Client, GetObjectCommand, PutObjectCommand, GetObjectCommandOutput } from '@aws-sdk/client-s3';
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Readable } from 'stream';
import dotenv from 'dotenv';

dotenv.config();

const R2_ENDPOINT = process.env.R2_ENDPOINT;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_KEY;
const VIDEO_BUCKET_NAME = process.env.VIDEO_BUCKET_NAME;
const CACHE_BUCKET_NAME = process.env.CACHE_BUCKET_NAME;

if (
  !R2_ENDPOINT ||
  !R2_ACCESS_KEY_ID ||
  !R2_SECRET_ACCESS_KEY ||
  !VIDEO_BUCKET_NAME ||
  !CACHE_BUCKET_NAME
) {
  console.error('Required environment variables are missing.');
  process.exit(1);
}

const s3Client = new S3Client({
  region: 'us-east-1',
  endpoint: R2_ENDPOINT,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
});

/**
 * Returns a stream of a file in cache bucket if it exists, otherwise - null
 * @param key the key in cache bucket
 * @returns 
 */
async function getCachedThumbnail(key: string): Promise<ReadableStream | null> {
  try {
    const command = new GetObjectCommand({
      Bucket: CACHE_BUCKET_NAME,
      Key: key,
    });

    const response: GetObjectCommandOutput = await s3Client.send(command);
    
    if (response.Body instanceof Readable) {
      return response.Body.transformToWebStream();
    } else {
      console.error('Unexpected response body type');
      return null;
    }
  } catch (error) {
    if ((error as any).name === 'NoSuchKey') {
      return null;
    }
    console.error('Error getting cached thumbnail:', error);
    throw error;
  }
}

/**
 * Uploads a thumbnail to the cache bucket
 * @param key the key in cache bucket
 * @param thumbnail the thumbnail buffer to upload
 */
async function uploadThumbnail(key: string, thumbnail: Buffer): Promise<void> {
  try {
    const command = new PutObjectCommand({
      Bucket: CACHE_BUCKET_NAME,
      Key: key,
      Body: thumbnail,
      ContentType: 'image/jpeg', // Adjust if you're using a different format
    });

    await s3Client.send(command);
  } catch (error) {
    console.error('Error uploading thumbnail:', error);
    throw error;
  }
}

/**
 * Generates a signed URL for accessing a video in the video bucket
 * @param key the key of the video in the video bucket
 * @returns a promise that resolves to the signed URL
 */
async function getSignedUrlForVideo(key: string): Promise<string> {
  try {
    const command = new GetObjectCommand({
      Bucket: VIDEO_BUCKET_NAME,
      Key: key,
    });

    // Generate a signed URL that expires in 1 hour (3600 seconds)
    const signedUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
    return signedUrl;
  } catch (error) {
    console.error('Error generating signed URL:', error);
    throw error;
  }
}

export {
  getCachedThumbnail,
  uploadThumbnail,
  getSignedUrlForVideo,
};