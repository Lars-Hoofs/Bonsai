import { isAudioOrVideo } from './media-type';

describe('isAudioOrVideo', () => {
  it('matches by audio/video mimetype', () => {
    expect(isAudioOrVideo('clip', 'audio/mpeg')).toBe(true);
    expect(isAudioOrVideo('clip', 'video/mp4')).toBe(true);
    expect(isAudioOrVideo('CLIP', 'AUDIO/WAV')).toBe(true);
  });

  it('matches by extension when mimetype is generic/empty', () => {
    expect(isAudioOrVideo('meeting.mp3', 'application/octet-stream')).toBe(
      true,
    );
    expect(isAudioOrVideo('call.M4A', '')).toBe(true);
    expect(isAudioOrVideo('webinar.MP4', '')).toBe(true);
    expect(isAudioOrVideo('podcast.opus', 'application/octet-stream')).toBe(
      true,
    );
  });

  it('does not match text/binary documents', () => {
    expect(isAudioOrVideo('notes.txt', 'text/plain')).toBe(false);
    expect(isAudioOrVideo('report.pdf', 'application/pdf')).toBe(false);
    expect(
      isAudioOrVideo(
        'doc.docx',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      ),
    ).toBe(false);
    expect(isAudioOrVideo('page.html', 'text/html')).toBe(false);
  });
});
