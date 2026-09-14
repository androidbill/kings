// Downscales Bill's card-back art from Downloads into public/cardbacks/ as compact
// web-sized JPEGs (originals are multi-MB, way oversized for a card-sized UI element).
import sharp from 'sharp';
import { mkdirSync } from 'node:fs';

const SRC_DIR = 'C:/Users/billd/Downloads';
const OUT_DIR = 'public/cardbacks';
mkdirSync(OUT_DIR, { recursive: true });

const files = [
  { src: 'Kings-01.png', out: 'crown.jpg', name: 'Royal Crown' },
  { src: 'Kings-02.png', out: 'compass.jpg', name: 'Star Compass' },
  { src: 'Kings-03.png', out: 'shell.jpg', name: 'Pearl Shell' },
  { src: 'Kings-04.png', out: 'leaf.jpg', name: 'Moonlit Leaf' },
  { src: 'Kings-05.png', out: 'crystal.jpg', name: 'Cosmic Crystal' },
];

for (const f of files) {
  let pipeline = sharp(`${SRC_DIR}/${f.src}`);
  // Kings-01 (crown) has a white margin baked into the export; trim it so the art
  // fills the card edge-to-edge like the others.
  if (f.src === 'Kings-01.png') pipeline = pipeline.trim({ background: '#ffffff', threshold: 10 });
  await pipeline
    .resize(240, 336, { fit: 'cover' })
    .jpeg({ quality: 82 })
    .toFile(`${OUT_DIR}/${f.out}`);
  console.log('wrote', f.out);
}
