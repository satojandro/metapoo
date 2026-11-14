-- Repair the mirror blob for tiles the draw log has and the board shows blank.
-- Authority is the log (itself rebuilt from chain events by `board-history backfill`).
-- Only fills a pixel whose stored owner id is 0, so it can never overwrite paint.
-- ARGV[1] = comma-separated palette hex in index order ("#rrggbb,...")
local pal = {}
for hex in string.gmatch(ARGV[1], "#(%x%x%x%x%x%x)") do
  pal[#pal + 1] = { tonumber(string.sub(hex, 1, 2), 16), tonumber(string.sub(hex, 3, 4), 16), tonumber(string.sub(hex, 5, 6), 16) }
end

local rows = redis.call('XRANGE', 'draw_history', '-', '+')
local final = {}
for _, row in ipairs(rows) do
  local f = {}
  for i = 1, #row[2], 2 do f[row[2][i]] = row[2][i + 1] end
  if f['x'] then
    final[f['x'] .. ',' .. f['y']] = { color = tonumber(f['color']), by = f['by'] }
  end
end

local blob = redis.call('GET', 'region:0:0')
if not blob or #blob ~= 98304 then return redis.error_reply('blob missing or wrong size') end
local idmap = redis.call('HGETALL', 'account_to_id')
local acct2id = {}
for i = 1, #idmap, 2 do acct2id[idmap[i]] = tonumber(idmap[i + 1]) end

local fixed, per_account = 0, {}
for k, v in pairs(final) do
  local x, y = string.match(k, '(%d+),(%d+)')
  x, y = tonumber(x), tonumber(y)
  local off = (y * 128 + x) * 6 + 1
  local b4, b5, b6 = string.byte(blob, off + 3, off + 5)
  local owner = b4 + b5 * 256 + b6 * 65536
  if owner == 0 then
    local c = pal[v.color + 1]
    if not c then return redis.error_reply('unknown colour index ' .. tostring(v.color)) end
    local id = acct2id[v.by]
    if not id then return redis.error_reply('no owner id for ' .. tostring(v.by)) end
    redis.call('SETRANGE', 'region:0:0', off - 1,
      string.char(c[1], c[2], c[3], id % 256, math.floor(id / 256) % 256, math.floor(id / 65536) % 256))
    fixed = fixed + 1
    per_account[v.by] = (per_account[v.by] or 0) + 1
  end
end

if fixed > 0 then
  for acct, n in pairs(per_account) do
    redis.call('HINCRBY', 'account_pixel_count', acct, n)
  end
end
return { fixed }
