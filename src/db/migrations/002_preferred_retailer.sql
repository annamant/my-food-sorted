-- Preferred supermarket for affiliate exit / sticky prefs
ALTER TABLE users ADD COLUMN IF NOT EXISTS preferred_retailer VARCHAR(50) DEFAULT 'tesco';
