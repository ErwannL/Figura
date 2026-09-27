// Regenerates every PNG, the favicon and the UI copies from the SVG masters.
import sharp from 'sharp';
import pngToIco from 'png-to-ico';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';

const logo = readFileSync('brand/logo.svg');
for (const size of [16, 32, 180, 192, 512, 1024]) {
  await sharp(logo, { density: Math.max(72, size * 2) })
    .resize(size, size)
    .png()
    .toFile(`brand/logo-${size}.png`);
}
await sharp(readFileSync('brand/og-image.svg'))
  .resize(1200, 630)
  .png()
  .toFile('brand/og-image.png');
writeFileSync('brand/favicon.ico', await pngToIco(['brand/logo-16.png', 'brand/logo-32.png']));
copyFileSync('brand/logo.svg', 'ui/public/logo.svg');
copyFileSync('brand/favicon.ico', 'ui/public/favicon.ico');
copyFileSync('brand/logo.svg', 'ui/public/favicon.svg');
copyFileSync('brand/logo-animated.svg', 'ui/public/logo-animated.svg');
console.info('brand assets regenerated');
