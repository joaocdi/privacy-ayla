// Public previews are irreversibly blurred derivative images, never originals.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const ffmpeg = require('@ffmpeg-installer/ffmpeg').path;
const root = path.resolve(__dirname, '../..');
const output = path.join(root, 'previews');
const sources = Array.from({length:7}, (_,i) => 'midias-ayla/posts/post-' + String(i+1).padStart(2,'0') + '.jpg');
fs.mkdirSync(output, { recursive: true });
sources.forEach((relative, index) => {
  const source = path.join(root, relative);
  if (!fs.existsSync(source)) throw new Error('Missing source for preview ' + (index + 1));
  const target = path.join(output, 'post-' + String(index + 1).padStart(2, '0') + '.jpg');
  execFileSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    ...(relative.endsWith('.mp4') ? ['-ss', '1'] : []), '-i', source,
    '-frames:v', '1', '-an', '-map_metadata', '-1',
    '-vf', 'scale=192:240:force_original_aspect_ratio=increase,crop=160:200,gblur=sigma=2:steps=3',
    '-q:v', '6', target
  ], { stdio: 'pipe' });
  console.log(path.relative(root, target));
});
