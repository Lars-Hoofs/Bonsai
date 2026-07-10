/**
 * Detects whether an uploaded file is audio or video (i.e. needs speech
 * transcription rather than the normal text/binary extraction path in
 * extract-text.ts). Matches on the declared mimetype first, then falls back
 * to the filename extension so uploads with a generic/empty mimetype
 * (application/octet-stream) are still routed correctly.
 */
const AUDIO_VIDEO_EXTENSIONS = [
  // audio
  '.mp3',
  '.wav',
  '.m4a',
  '.aac',
  '.ogg',
  '.oga',
  '.opus',
  '.flac',
  '.wma',
  // video
  '.mp4',
  '.m4v',
  '.mov',
  '.webm',
  '.mkv',
  '.avi',
  '.mpeg',
  '.mpg',
  '.wmv',
];

export function isAudioOrVideo(filename: string, mimetype: string): boolean {
  const mt = mimetype.toLowerCase();
  if (mt.startsWith('audio/') || mt.startsWith('video/')) return true;
  const lower = filename.toLowerCase();
  return AUDIO_VIDEO_EXTENSIONS.some((ext) => lower.endsWith(ext));
}
