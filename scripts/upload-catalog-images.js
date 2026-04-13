/**
 * upload-catalog-images.js
 * Upload les images catalogue locales vers Cloudinary (dossier "catalog/")
 * et génère le fichier src/utils/catalogImageMap.ts pour le frontend.
 *
 * Usage: node scripts/upload-catalog-images.js
 */

// Required for corporate/dev environments with self-signed SSL certs
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const cloudinary = require('cloudinary').v2;
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const IMAGES_DIR = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(__dirname, '../../web-frontend/src/assets/generated_images');
const OUTPUT_FILE = path.resolve(__dirname, '../../web-frontend/src/utils/catalogImageMap.ts');
const CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME;

async function uploadFile(filePath, publicId) {
  const result = await cloudinary.uploader.upload(filePath, {
    public_id: publicId,
    folder: 'catalog',
    overwrite: true,
    resource_type: 'image',
  });
  return result.public_id;
}

function buildUrl(publicId) {
  return `https://res.cloudinary.com/${CLOUD_NAME}/image/upload/f_auto,q_auto,w_300/${publicId}.png`;
}

async function main() {
  const files = fs.readdirSync(IMAGES_DIR).filter(f => /\.(png|jpg|jpeg|webp)$/i.test(f));
  console.log(`Found ${files.length} images to upload`);

  const map = {}; // id → URL

  for (const file of files) {
    const id = path.basename(file, path.extname(file)); // e.g. "p_01_01_001"
    const filePath = path.join(IMAGES_DIR, file);

    try {
      let publicId;
      try {
        const existing = await cloudinary.api.resource(`catalog/${id}`);
        publicId = existing.public_id;
        console.log(`  ✓ Already on Cloudinary: ${id}`);
      } catch (checkErr) {
        if (checkErr && checkErr.http_code && checkErr.http_code !== 404) throw checkErr;
        publicId = await uploadFile(filePath, id);
        console.log(`  ↑ Uploaded: ${id}`);
      }
      map[id] = publicId;
    } catch (err) {
      console.error(`  ✗ Failed: ${id}`, err && (err.message || JSON.stringify(err)));
    }
  }

  console.log(`\n✅ Done — ${Object.keys(map).length}/${files.length} images on Cloudinary`);
  console.log(`   URLs are generated automatically via getCatalogImageUrl(id) — no map file needed.`);
}

main().catch(err => { console.error(err); process.exit(1); });
