import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';

const requireApi = createRequire(new URL('../../../../api/package.json', import.meta.url));
const sharp = requireApi('sharp');
export async function mediaFixture(root, kind, version = 1) {
  const name = version === 1 ? `review-input.${kind}` : `review-response.${kind}`;
  if (kind === 'png')
    await writeFile(
      path.join(root, name),
      await sharp(
        Buffer.from(
          `<svg width="900" height="600" xmlns="http://www.w3.org/2000/svg"><rect width="900" height="600" fill="#f8f2e5"/><circle cx="710" cy="145" r="72" fill="#c8754d"/><rect x="80" y="130" width="550" height="170" rx="20" fill="${version === 1 ? '#48705b' : '#405e4e'}"/><text x="120" y="220" fill="#fff" font-family="sans-serif" font-size="48">AUTUMN AT CAT CAFE</text><text x="90" y="430" fill="#805643" font-family="sans-serif" font-size="28">Version ${version} · review sentinel ${version}</text></svg>`,
        ),
      )
        .png()
        .toBuffer(),
    );
  else
    await promisify(execFile)(
      'ffmpeg',
      [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        `testsrc2=s=640x360:r=25:d=3`,
        '-vf',
        version === 1 ? 'setpts=PTS' : 'hue=h=25',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-movflags',
        '+faststart',
        path.join(root, name),
      ],
      { timeout: 15000 },
    );
  return name;
}

export async function offsetRotatedVfrFixture(root) {
  const execute = promisify(execFile);
  const base = path.join(root, 'vfr-base.mp4');
  const destination = path.join(root, 'review-input.mp4');
  await execute(
    'ffmpeg',
    [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'nullsrc=s=640x360:r=25:d=3',
      '-vf',
      "geq=r='mod(N*13,200)+if(lt(X,W/2),0,45)':g='mod(N*29,200)+if(lt(Y,H/2),0,45)':b='mod(N*47,240)',select='if(lt(n,20),1,not(mod(n,3)))',setpts=PTS+2/TB",
      '-fps_mode',
      'vfr',
      '-c:v',
      'libx264',
      '-bf',
      '0',
      '-pix_fmt',
      'yuv420p',
      '-video_track_timescale',
      '12800',
      base,
    ],
    { timeout: 15000 },
  );
  await execute(
    'ffmpeg',
    [
      '-v',
      'error',
      '-copyts',
      '-display_rotation:v:0',
      '90',
      '-i',
      base,
      '-c',
      'copy',
      '-movflags',
      '+faststart',
      destination,
    ],
    { timeout: 15000 },
  );
  const { stdout } = await execute(
    'ffprobe',
    ['-v', 'error', '-select_streams', 'v:0', '-show_streams', '-show_frames', '-of', 'json', destination],
    { timeout: 15000, maxBuffer: 1048576 },
  );
  const samples = path.join(root, 'vfr-frames.rgb');
  await execute(
    'ffmpeg',
    [
      '-v',
      'error',
      '-i',
      destination,
      '-vf',
      'scale=16:16',
      '-fps_mode',
      'passthrough',
      '-pix_fmt',
      'rgb24',
      '-f',
      'rawvideo',
      samples,
    ],
    { timeout: 15000 },
  );
  return { ...JSON.parse(stdout), samples: await readFile(samples) };
}
