/**
 * STUB — SQLite đã bị loại bỏ để tránh lỗi GLIBC trên Render.
 * Hệ thống V2 dùng in-memory Map + state.json là đủ.
 */

console.log('[DB] SQLite disabled — using in-memory + state.json only');

module.exports = {
  run: () => {},
  get: () => null,
  all: () => [],
  close: () => {},
  ready: false,
};