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
    overwrite: false,         // ne ré-upload pas si déjà présent
    resource_type: 'image',
  });
  return result.public_id; // e.g. "catalog/p_01_01_001"
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
      // Check if already uploaded to avoid unnecessary API calls
      let publicId;
      try {
        const existing = await cloudinary.api.resource(`catalog/${id}`);
        publicId = existing.public_id;
        console.log(`  ✓ Already uploaded: ${id}`);
      } catch (checkErr) {
        // 404 = not found → upload; anything else = rethrow
        if (checkErr && checkErr.http_code && checkErr.http_code !== 404) throw checkErr;
        publicId = await uploadFile(filePath, id);
        console.log(`  ↑ Uploaded: ${id}`);
      }
      map[id] = buildUrl(publicId);
    } catch (err) {
      console.error(`  ✗ Failed: ${id}`, err && (err.message || JSON.stringify(err)));
    }
  }

  // Generate TypeScript file
  const entries = Object.entries(map)
    .map(([k, v]) => `  '${k}': '${v}',`)
    .join('\n');

  const tsContent = `// AUTO-GENERATED — run web-backend/scripts/upload-catalog-images.js to regenerate
// Images catalogue hébergées sur Cloudinary, générées depuis src/assets/generated_images/
export const CATALOG_IMAGE_MAP: Record<string, string> = {
${entries}
};

const CLOUD_NAME = '${CLOUD_NAME}';

export function getCatalogImageUrl(id: string): string | null {
  return CATALOG_IMAGE_MAP[id] ?? null;
}
`;

  fs.writeFileSync(OUTPUT_FILE, tsContent, 'utf-8');
  console.log(`\n✅ catalogImageMap.ts written with ${Object.keys(map).length} entries`);
}

main().catch(err => { console.error(err); process.exit(1); });
