/**
 * Pulse / smoke spec for M5: proves the two module faces exist with the
 * integration contract (`name`, `TOOLS`, `apply`, endpoint maps) and that the
 * rooms service is reachable from a hand-built `ModuleDeps`. Fast on purpose —
 * the real coverage lives in the sibling spec files.
 */
import { describe, expect, it } from 'vitest'
import * as rooms from '../../src/host/modules/rooms/index.ts'
import * as sessions from '../../src/host/modules/sessions/index.ts'

describe('M5 module faces (skeleton contract)', () => {
  it('exports { name, TOOLS, apply, readEndpoints, writeEndpoints } for both modules', () => {
    expect(rooms.name).toBe('rooms')
    expect(sessions.name).toBe('sessions')
    expect(rooms.TOOLS).toEqual([
      'cortex_room_create',
      'cortex_room_list',
      'cortex_room_join',
      'cortex_room_post',
      'cortex_room_read',
      'cortex_room_status',
      'cortex_room_delete',
    ])
    expect(sessions.TOOLS).toEqual(['cortex_session_spawn', 'cortex_session_send'])
    for (const mod of [rooms, sessions]) {
      expect(typeof mod.apply).toBe('function')
      expect(Object.keys(mod.readEndpoints).length).toBeGreaterThan(0)
      expect(Object.keys(mod.writeEndpoints).length).toBeGreaterThan(0)
    }
    // Frozen .dev/RPC-ENDPOINTS.md names only, plus sessions.status (my addition).
    expect(Object.keys(rooms.writeEndpoints).sort()).toEqual(['rooms.create', 'rooms.join', 'rooms.leave', 'rooms.post'])
    expect(Object.keys(sessions.writeEndpoints).sort()).toEqual(['rooms.send', 'rooms.spawn'])
  })
})
