import { Router } from 'express';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { PrismaClient } from '@prisma/client';
import multer from 'multer';

const router = Router();
const prisma = new PrismaClient();

// Configure multer pour gérer les uploads d'images
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB max
});

// Initialiser Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

router.post('/analyze', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No image provided' });
    }

    // Convertir l'image en base64
    const base64Image = req.file.buffer.toString('base64');
    const mimeType = req.file.mimetype;

    const prompt = `Analyse cette image et extrait UNIQUEMENT les séquences de chiffres qui ressemblent à des codes-barres (entre 7 et 13 chiffres consécutifs).
    
Règles strictes:
- Retourne UNIQUEMENT les nombres entre 7 et 13 chiffres
- Un nombre par ligne
- Pas de texte explicatif
- Pas de formatage
- Si aucun code n'est trouvé, retourne "AUCUN"

Exemples de codes valides:
7290011447359
1234567890123
729001144

Ne retourne PAS les prix, dates, quantités ou autres nombres courts.`;

    // Utiliser gemini-2.5-flash qui supporte les images
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

    const imagePart = {
      inlineData: {
        data: base64Image,
        mimeType: mimeType
      }
    };

    const result = await model.generateContent([prompt, imagePart]);
    const response = await result.response;
    const text = response.text();
    
    console.log('Gemini response:', text);

    // Extraire les codes de la réponse
    const lines = text.split('\n').map(line => line.trim()).filter(Boolean);
    const barcodes: string[] = [];

    for (const line of lines) {
      // Extraire seulement les chiffres
      const numbers = line.match(/\d+/g);
      if (numbers) {
        for (const num of numbers) {
          if (num.length >= 7 && num.length <= 13) {
            barcodes.push(num);
          }
        }
      }
    }

    // Supprimer les doublons
    const uniqueBarcodes = [...new Set(barcodes)];

    if (uniqueBarcodes.length === 0) {
      return res.json({ barcodes: [], products: [] });
    }

    // Vérifier dans la base de données
    const products = await prisma.product.findMany({
      where: {
        itemCode: {
          in: uniqueBarcodes
        }
      },
      include: {
        prices: {
          orderBy: { priceUpdateDate: 'desc' },
          take: 1
        }
      }
    });

    // Créer une map pour retrouver les produits facilement
    const productMap = new Map(products.map(p => [p.itemCode, p]));

    // Retourner les résultats avec l'info si le produit existe ou non
    const results = uniqueBarcodes.map(barcode => {
      const product = productMap.get(barcode);
      return {
        barcode,
        found: !!product,
        product: product ? {
          itemCode: product.itemCode,
          itemName: product.itemName,
          manufacturerName: product.manufacturerName,
          price: product.prices[0]?.basePrice || null,
          storeName: null
        } : null
      };
    });

    res.json({
      barcodes: uniqueBarcodes,
      products: results
    });

  } catch (error) {
    console.error('Error analyzing image:', error);
    res.status(500).json({ error: 'Failed to analyze image' });
  }
});

export default router;
