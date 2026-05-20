import { Prisma } from '@prisma/client';

export const GLOBAL_CHAIN_IDS = [
  '5144744100002', // משנת יוסף - קיי טי יבוא ושיווק בע"מ
];

export const SHUFERSAL_CHAIN_ID = '7290027600007';
export const SHUFERSAL_ONLINE_STORE_ID = '413';
export const SHUFERSAL_ONLINE_CHAIN_NAME = 'שופרסל ONLINE';

type StoreAlias = 's' | 'c' | 'spc';

function normalizeText(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

export function isGlobalStoreRef(chainId: string | null | undefined, storeId: string | null | undefined): boolean {
  const chain = (chainId ?? '').trim();
  const store = (storeId ?? '').trim();
  return GLOBAL_CHAIN_IDS.includes(chain)
    || (chain === SHUFERSAL_CHAIN_ID && store === SHUFERSAL_ONLINE_STORE_ID);
}

export function isGlobalChainSelection(chainId: string | null | undefined, chainName: string | null | undefined): boolean {
  const chain = (chainId ?? '').trim();
  if (GLOBAL_CHAIN_IDS.includes(chain)) return true;
  return chain === SHUFERSAL_CHAIN_ID
    && normalizeText(chainName) === normalizeText(SHUFERSAL_ONLINE_CHAIN_NAME);
}

export function shouldBypassCityForSelection(
  chainId: string | null | undefined,
  chainName: string | null | undefined,
  storeId: string | null | undefined,
): boolean {
  return isGlobalStoreRef(chainId, storeId) || isGlobalChainSelection(chainId, chainName);
}

export function isGlobalStoreSql(alias: StoreAlias): Prisma.Sql {
  const table = Prisma.raw(alias);
  return Prisma.sql`(
    ${table}.chain_id = ANY(${GLOBAL_CHAIN_IDS}::text[])
    OR (${table}.chain_id = '7290027600007' AND ${table}.store_id = '413')
  )`;
}

export function cityScopedStoreSql(
  alias: StoreAlias,
  city: string | null,
  options: { prefix?: boolean } = {},
): Prisma.Sql {
  const table = Prisma.raw(alias);
  const cityParam = city && city.trim() ? city.trim() : null;
  const cityMatch = options.prefix === false
    ? Prisma.sql`${table}.city = ${cityParam}::text`
    : Prisma.sql`(${table}.city = ${cityParam}::text OR ${table}.city ILIKE ${cityParam}::text || '%')`;

  return Prisma.sql`(
    ${cityParam}::text IS NULL
    OR ${cityMatch}
    OR ${isGlobalStoreSql(alias)}
  )`;
}

export function cityScopedStoreSqlForSelection(
  alias: StoreAlias,
  city: string | null,
  selection: { chainId?: string | null; chainName?: string | null; storeId?: string | null },
  options: { prefix?: boolean } = {},
): Prisma.Sql {
  if (shouldBypassCityForSelection(selection.chainId, selection.chainName, selection.storeId)) {
    return Prisma.sql`TRUE`;
  }

  return cityScopedStoreSql(alias, city, options);
}
