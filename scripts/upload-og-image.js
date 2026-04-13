/**
 * upload-og-image.js
 * Upload le SVG de la carte Open Graph vers Cloudinary (public_id: og/og-card)
 * et affiche l'URL finale à utiliser dans index.html.
 *
 * Usage: node scripts/upload-og-image.js
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const cloudinary = require('cloudinary').v2;
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const SVG_FILE = path.resolve(__dirname, '../../web-frontend/public/og-card.svg');
const CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME;

async function main() {
  console.log('⬆️  Upload de og-card.svg vers Cloudinary...');

  const result = await cloudinary.uploader.upload(SVG_FILE, {
    public_id: 'og-card',
    folder: 'og',
    overwrite: true,
    resource_type: 'image',
    format: 'png',
    transformation: [{ width: 1200, height: 630, crop: 'fill' }],
  });

  const url = `https://res.cloudinary.com/${CLOUD_NAME}/image/upload/f_png,w_1200,h_630/og/og-card.png`;

  console.log('\n✅ Upload réussi!');
  console.log(`\n📸 URL à utiliser dans index.html :\n   ${url}`);
  console.log('\n➡️  Mets à jour la balise og:image dans web-frontend/index.html avec cette URL.');
}

main().catch((err) => {
  console.error('❌ Erreur:', err.message);
  process.exit(1);
});
