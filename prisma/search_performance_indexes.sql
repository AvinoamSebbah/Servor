-- Run these indexes in production to speed up /api/products/search
-- Recommended: execute during low traffic windows.

-- Required for trigram fuzzy matching
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 1) Fast full-text ranking/filter
CREATE INDEX IF NOT EXISTS idx_products_search_idx_col_gin
ON products USING GIN (search_idx_col);

-- 2) Fast fuzzy fallback (% / similarity) on Hebrew text
CREATE INDEX IF NOT EXISTS idx_products_item_name_trgm
ON products USING GIN (item_name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_products_manufacturer_name_trgm
ON products USING GIN (manufacturer_name gin_trgm_ops);

-- 3) Strict city product filtering through prices.available_in_store_ids && cityStoreIds
CREATE INDEX IF NOT EXISTS idx_prices_available_in_store_ids_gin
ON prices USING GIN (available_in_store_ids);

CREATE INDEX IF NOT EXISTS idx_prices_item_code
ON prices (item_code);

CREATE INDEX IF NOT EXISTS idx_stores_city
ON stores (city);

-- 4) Promotions filtering (active window + city + chain)
CREATE INDEX IF NOT EXISTS idx_promotions_available_in_store_ids_gin
ON promotions USING GIN (available_in_store_ids);

CREATE INDEX IF NOT EXISTS idx_promotions_chain_id
ON promotions (chain_id);

CREATE INDEX IF NOT EXISTS idx_promotions_start_end
ON promotions (promotion_start_date, promotion_end_date);

CREATE INDEX IF NOT EXISTS idx_promotions_club_id
ON promotions (club_id);

CREATE INDEX IF NOT EXISTS idx_promotion_items_item_code
ON promotion_items (item_code);
