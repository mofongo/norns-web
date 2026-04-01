-- mods/midi-enc.lua
-- Maps MIDI CC → enc(n, delta) and MIDI notes → key(n, z).
--
-- Uses relative signed-bit CC mode (standard for most hardware encoders):
--   CC value 1–63  → positive delta (+1 to +63)
--   CC value 65–127 → negative delta (-63 to -1)
--   CC value 64    → 0 (no movement)
--
-- Configuration table MidiEnc can be set by a script's init() or by the
-- host page before loading, and will be read when script_post_init fires:
--
--   MidiEnc = {
--     port    = 1,                          -- MIDI port (1 = first hardware device)
--     cc_map  = { [1]=1, [2]=2, [3]=3 },   -- CC number → encoder number
--     key_map = { [36]=1, [37]=2, [38]=3 }, -- note → key number
--   }

local mod = require 'core/mods'

-- Default config — override by setting MidiEnc before or inside init()
if not MidiEnc then
  MidiEnc = {
    port    = 1,
    cc_map  = { [1] = 1, [2] = 2, [3] = 3 },
    key_map = { [36] = 1, [37] = 2, [38] = 3 },
  }
end

local _m = nil

mod.hook.register("script_post_init", "midi-enc", function()
  local cfg = MidiEnc
  _m = midi.connect(cfg.port)
  _m.event = function(data)
    local msg = midi.to_msg(data)
    if not msg then return end

    if msg.type == "cc" then
      local enc_n = cfg.cc_map[msg.cc]
      if enc_n then
        local delta = msg.val
        if delta >= 64 then delta = delta - 128 end  -- signed-bit decode
        if type(enc) == "function" then enc(enc_n, delta) end
      end

    elseif msg.type == "note_on" then
      local key_n = cfg.key_map[msg.note]
      if key_n and type(key) == "function" then key(key_n, 1) end

    elseif msg.type == "note_off" then
      local key_n = cfg.key_map[msg.note]
      if key_n and type(key) == "function" then key(key_n, 0) end
    end
  end
end)

mod.hook.register("script_pre_cleanup", "midi-enc", function()
  _m = nil
end)
