import { Router } from 'express';
import { PrismaClient, Prisma } from '@prisma/client';

const router = Router();
const prisma = new PrismaClient();


// GET /api/stores/chain/:chainId - list stores for a chain
router.get('/chain/:chainId', async (req, res) => {
  try {
    const { chainId } = req.params;
    console.log('Listing stores for chainId:', chainId);

    type StoreRow = {
      id: number;
      chain_id: string;
      chain_name: string | null;
      store_id: string;
      store_name: string | null;
      address: string | null;
      city: string | null;
      zip_code: string | null;
      created_at: Date;
      updated_at: Date;
    };

    const rows = await prisma.$queryRaw<StoreRow[]>(Prisma.sql`
      SELECT id, chain_id, chain_name, store_id, store_name, address, city, zip_code, created_at, updated_at
      FROM stores
      WHERE chain_id = ${chainId}
      ORDER BY store_name NULLS LAST, id
      LIMIT 500
    `);

    const stores = rows.map(r => ({
      id: r.id,
      chainId: r.chain_id,
      chainName: r.chain_name,
      storeId: r.store_id,
      storeName: r.store_name,
      address: r.address,
      city: r.city,
      zipCode: r.zip_code,
    }));

    res.json(stores);
  } catch (error) {
    console.error('Chain stores fetch error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});
// GET /api/stores/:id - Get store details
// GET /api/stores/:chainId/:storeId - Get store details by chainId and storeId
router.get('/:chainId/:storeId', async (req, res) => {
  try {
    const { chainId, storeId } = req.params;
    console.log('Fetching store with chainId:', chainId, 'and storeId:', storeId);

    type StoreRow = {
      id: number;
      chain_id: string;
      chain_name: string | null;
      last_update_date: string | null;
      last_update_time: string | null;
      store_id: string;
      bikoret_no: string | null;
      store_type: string | null;
      store_name: string | null;
      address: string | null;
      city: string | null;
      zip_code: string | null;
      created_at: Date;
      updated_at: Date;
    };

    const rows = await prisma.$queryRaw<StoreRow[]>(Prisma.sql`
      SELECT
        id,
        chain_id,
        chain_name,
        last_update_date::text AS last_update_date,
        last_update_time::text AS last_update_time,
        store_id,
        bikoret_no,
        store_type,
        store_name,
        address,
        city,
        zip_code,
        created_at,
        updated_at
      FROM stores
      WHERE chain_id = ${chainId} AND store_id = ${storeId}
      LIMIT 1
    `);

    console.log('Store query result:', rows);

    const row = rows[0];
    const store = row
      ? {
          id: row.id,
          chainId: row.chain_id,
          chainName: row.chain_name,
          lastUpdateDate: row.last_update_date,
          lastUpdateTime: row.last_update_time,
          storeId: row.store_id,
          bikoretNo: row.bikoret_no,
          storeType: row.store_type,
          storeName: row.store_name,
          address: row.address,
          city: row.city,
          zipCode: row.zip_code,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        }
      : null;

    if (!store) {
      console.log('Store not found for chainId:', chainId, 'storeId:', storeId);
      return res.status(404).json({ error: 'Store not found' });
    }

    res.json(store);
  } catch (error) {
    console.error('Store fetch error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});



// Backwards-compatible route: GET /api/stores/:storeId
// Tries to resolve by store_id (string) first, then by numeric id
router.get('/:storeId', async (req, res) => {
  try {
    const { storeId } = req.params;
    console.log('Fetching store by storeId or id:', storeId);

    type StoreRow = {
      id: number;
      chain_id: string;
      chain_name: string | null;
      last_update_date: string | null;
      last_update_time: string | null;
      store_id: string;
      bikoret_no: string | null;
      store_type: string | null;
      store_name: string | null;
      address: string | null;
      city: string | null;
      zip_code: string | null;
      created_at: Date;
      updated_at: Date;
    };

    const rows = await prisma.$queryRaw<StoreRow[]>(Prisma.sql`
      SELECT
        id,
        chain_id,
        chain_name,
        last_update_date::text AS last_update_date,
        last_update_time::text AS last_update_time,
        store_id,
        bikoret_no,
        store_type,
        store_name,
        address,
        city,
        zip_code,
        created_at,
        updated_at
      FROM stores
      WHERE store_id = ${storeId} OR id::text = ${storeId}
      LIMIT 1
    `);

    const row = rows[0];
    const store = row
      ? {
          id: row.id,
          chainId: row.chain_id,
          chainName: row.chain_name,
          lastUpdateDate: row.last_update_date,
          lastUpdateTime: row.last_update_time,
          storeId: row.store_id,
          bikoretNo: row.bikoret_no,
          storeType: row.store_type,
          storeName: row.store_name,
          address: row.address,
          city: row.city,
          zipCode: row.zip_code,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        }
      : null;

    if (!store) return res.status(404).json({ error: 'Store not found' });

    res.json(store);
  } catch (error) {
    console.error('Store fetch (id) error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
