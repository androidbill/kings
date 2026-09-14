// Downscales Bill's 4 King illustrations from Downloads into public/kingart/ as
// compact web-sized JPEGs, used both as the King's card face (grid/holding/burn) and
// the big celebration overlay.
import sharp from 'sharp';
import { mkdirSync } from 'node:fs';

const SRC_DIR = 'C:/Users/billd/Downloads';
const OUT_DIR = 'public/kingart';
mkdirSync(OUT_DIR, { recursive: true });

const files = [
  { src: 'kings-spades.png', out: 'S.jpg' },
  { src: 'kings-hearts.png', out: 'H.jpg' },
  { src: 'kings-diamonds.png', out: 'D.jpg' },
  { src: 'kings-clubs.png', out: 'C.jpg' },
];

for (const f of files) {
  await sharp(`${SRC_DIR}/${f.src}`)
    .trim({ background: '#ffffff', threshold: 10 })
    .resize(300, 420, { fit: 'cover' })
    .jpeg({ quality: 86 })
    .toFile(`${OUT_DIR}/${f.out}`);
  console.log('wrote', f.out);
}
