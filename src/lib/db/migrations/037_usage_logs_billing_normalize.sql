-- 037_usage_logs_billing_normalize — disjoint OpenAI input + web-search / price provenance.
--
-- New writes store uncached input_tokens (cache read/write in their own columns).
-- Historical OpenAI-inclusive rows are rewritten with the same CASE that
-- PROMPT_TOKENS_SQL used before this migration, so SUM(prompt) is unchanged.
-- via / protocol / stream may be NULL (001_init, 002_request_log_crs): CASE
-- treats a NULL condition as not matching and falls through. Do not rewrite
-- this WHERE as NOT (...) AND (...).
-- OPENAI IN-list is the 2026-10-14 OPENAI_OFFICIAL_RATES key set, inlined.

ALTER TABLE usage_logs ADD COLUMN web_search_requests INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage_logs ADD COLUMN web_search_cost REAL;
ALTER TABLE usage_logs ADD COLUMN price_source TEXT;
ALTER TABLE usage_logs ADD COLUMN price_version TEXT;

UPDATE usage_logs
   SET input_tokens = MAX(IFNULL(input_tokens,0) - IFNULL(cache_read_tokens,0) - IFNULL(cache_creation_tokens,0), 0)
 WHERE (CASE
          WHEN via = 'api-kernel' AND protocol = 'anthropic.messages' AND stream = 0 THEN 0
          WHEN via LIKE 'codex-%'
            OR (
              LOWER(TRIM(COALESCE(
                NULLIF(NULLIF(pricing_model, ''), 'unpriced'), NULLIF(upstream_model, ''),
                NULLIF(model, ''), requested_model, ''
              ))) LIKE 'gpt%'
              AND LOWER(TRIM(COALESCE(
                NULLIF(NULLIF(pricing_model, ''), 'unpriced'), NULLIF(upstream_model, ''),
                NULLIF(model, ''), requested_model, ''
              ))) NOT LIKE 'gpt-image%'
            )
            OR LOWER(TRIM(COALESCE(
              NULLIF(NULLIF(pricing_model, ''), 'unpriced'), NULLIF(upstream_model, ''),
              NULLIF(model, ''), requested_model, ''
            ))) LIKE 'codex-%'
            OR LOWER(TRIM(COALESCE(
              NULLIF(NULLIF(pricing_model, ''), 'unpriced'), NULLIF(upstream_model, ''),
              NULLIF(model, ''), requested_model, ''
            ))) IN (
              'gpt-6-astra',
              'gpt-6.1-sol',
              'gpt-6-sol',
              'gpt-6-luna',
              'gpt-5.6-sol',
              'gpt-5.6-terra',
              'gpt-5.6-luna',
              'gpt-5.6',
              'gpt-5.5-pro',
              'gpt-5.5',
              'gpt-5.4-mini',
              'gpt-5.4-nano',
              'gpt-5.4-pro',
              'gpt-5.4',
              'gpt-5.3-codex',
              'gpt-5.2-pro',
              'gpt-5.2',
              'gpt-5.1',
              'gpt-5-mini',
              'gpt-5-nano',
              'gpt-5-pro',
              'gpt-5',
              'gpt-4.1-mini',
              'gpt-4.1-nano',
              'gpt-4.1',
              'gpt-4o-2024-05-13',
              'gpt-4o-mini',
              'gpt-4o',
              'o1-pro',
              'o1',
              'o3-pro',
              'o3-mini',
              'o3',
              'o4-mini',
              'gpt-4-turbo',
              'gpt-4',
              'gpt-3.5-turbo-instruct',
              'gpt-3.5-turbo-1106',
              'gpt-3.5-turbo',
              'gpt-5.1-codex-mini',
              'gpt-5.3-chat-latest',
              'gpt-5.6-cyber',
              'gpt-5.5-cyber',
              'chat-latest',
              'gpt-5-codex',
              'gpt-5.1-codex',
              'gpt-5.1-codex-max',
              'gpt-5-chat-latest',
              'gpt-5.1-chat-latest',
              'gpt-5.2-codex',
              'gpt-5.2-chat-latest'
            )
          THEN 1
          ELSE 0
        END) = 1;

-- Earliest instant with complete summaries. Cleanup advances it whenever it deletes
-- rows; prunes before this release were never recorded, so existing rows can only
-- vouch for history from the oldest surviving one onward.
INSERT OR IGNORE INTO settings (key, value, updated_at)
SELECT 'usage_logs_pruned_through', '"' || t || '"', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM (SELECT MIN(created_at) AS t FROM usage_logs)
 WHERE t IS NOT NULL;
