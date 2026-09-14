// Builds public/icons/*.png from Bill's new "K" crown icon.
import sharp from 'sharp';

const SRC = 'C:/Users/billd/OneDrive/Desktop/king-cards/kings-pwa-icon.png';
const OUT = 'public/icons';

await sharp(SRC).resize(192, 192).png().toFile(`${OUT}/icon-192.png`);
await sharp(SRC).resize(512, 512).png().toFile(`${OUT}/icon-512.png`);

// The source art already bleeds a radial glow to every edge with no hard border, so
// it works directly as a maskable icon (a launcher's circular crop just eats a little
// of the glow, not the crown/K). Padding it onto a flat background earlier produced a
// visible seam where the resized glow met the flat fill — full-bleed avoids that.
await sharp(SRC).resize(512, 512).png().toFile(`${OUT}/icon-maskable-512.png`);

console.log('Icons written to public/icons/');
