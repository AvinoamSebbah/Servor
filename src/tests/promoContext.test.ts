import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyPromotionKind } from '../services/promoContext';

test('club id for all customers is treated as a regular promotion', () => {
  const promo = classifyPromotionKind({
    promotion_description: 'ישח 19.90 מצות יד ש.שועל לל"ג 3יח',
    additional_is_coupon: '0.0',
    additional_restrictions: null,
    club_id: '0 - כלל הלקוחות',
  });

  assert.equal(promo.promoKind, 'regular');
  assert.equal(promo.isConditionalPromo, false);
});

test('positive club id is still treated as a club promotion', () => {
  const promo = classifyPromotionKind({
    promotion_description: 'הטבת מועדון',
    additional_is_coupon: '0',
    additional_restrictions: null,
    club_id: '12',
  });

  assert.equal(promo.promoKind, 'club');
  assert.equal(promo.isConditionalPromo, true);
});
