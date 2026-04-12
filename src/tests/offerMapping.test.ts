import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildOffsetPagination,
  mapOfferRow,
  mapOffersToLegacyDetails,
  toNullableNumber,
  type RawOfferRow,
} from '../services/offerMapping';

test('toNullableNumber parses numeric-like values and rejects invalid inputs', () => {
  assert.equal(toNullableNumber('12.5'), 12.5);
  assert.equal(toNullableNumber(7), 7);
  assert.equal(toNullableNumber('abc'), null);
  assert.equal(toNullableNumber(undefined), null);
});

test('mapOfferRow normalizes DB row to API shape', () => {
  const row: RawOfferRow = {
    item_code: '729001',
    item_name: 'Test Product',
    manufacturer_name: 'Maker',
    chain_id: '7290058179879',
    store_id: '101',
    store_name: 'Store A',
    city: 'Tel Aviv',
    price: '10.90',
    promo_price: '9.90',
    effective_price: '9.90',
    updated_at: new Date('2026-03-24T10:00:00Z'),
  };

  const mapped = mapOfferRow(row);
  assert.equal(mapped.itemCode, '729001');
  assert.equal(mapped.price, 10.9);
  assert.equal(mapped.promoPrice, 9.9);
  assert.equal(mapped.effectivePrice, 9.9);
  assert.equal(typeof mapped.updatedAt, 'string');
});

test('promo is exposed only when promoPrice is strictly better than price', () => {
  const offers = [
    {
      itemCode: '1',
      itemName: 'Milk',
      manufacturerName: 'A',
      chainId: '10',
      storeId: '1',
      storeName: 'S1',
      city: 'Jerusalem',
      price: 10,
      promoPrice: 10,
      effectivePrice: 10,
      updatedAt: '2026-03-24T10:00:00.000Z',
    },
    {
      itemCode: '1',
      itemName: 'Milk',
      manufacturerName: 'A',
      chainId: '11',
      storeId: '2',
      storeName: 'S2',
      city: 'Jerusalem',
      price: 12,
      promoPrice: 9,
      effectivePrice: 9,
      updatedAt: '2026-03-24T10:00:00.000Z',
    },
  ];

  const details = mapOffersToLegacyDetails(offers);
  assert.equal(details.promotions.length, 1);
  assert.equal(details.promotions[0].discounted_price, '9');
});

test('best effective price remains coherent with offers', () => {
  const offers = [
    {
      itemCode: '1',
      itemName: 'Rice',
      manufacturerName: 'B',
      chainId: '10',
      storeId: '1',
      storeName: 'S1',
      city: 'Haifa',
      price: 15,
      promoPrice: null,
      effectivePrice: 15,
      updatedAt: '2026-03-24T10:00:00.000Z',
    },
    {
      itemCode: '1',
      itemName: 'Rice',
      manufacturerName: 'B',
      chainId: '11',
      storeId: '2',
      storeName: 'S2',
      city: 'Haifa',
      price: 16,
      promoPrice: 12,
      effectivePrice: 12,
      updatedAt: '2026-03-24T11:00:00.000Z',
    },
  ];

  const details = mapOffersToLegacyDetails(offers);
  assert.equal(details.bestPrice, 15);
  assert.equal(details.bestEffectivePrice, 12);
});

test('offset pagination keeps deterministic page and hasMore behavior', () => {
  const firstPage = buildOffsetPagination(10, 0, 10);
  const secondPage = buildOffsetPagination(10, 10, 3);

  assert.equal(firstPage.page, 1);
  assert.equal(firstPage.hasMore, true);
  assert.equal(secondPage.page, 2);
  assert.equal(secondPage.hasMore, false);
});