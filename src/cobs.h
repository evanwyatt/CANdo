#pragma once
#include <stddef.h>
#include <stdint.h>

// Encode `src_len` bytes from `src` into `dst` using COBS.
// `dst` must be at least src_len + 2 bytes (overhead byte + 0x00 delimiter).
// Returns the number of bytes written to `dst`, including the trailing 0x00.
size_t cobs_encode(const uint8_t *src, size_t src_len, uint8_t *dst);

// Decode COBS-encoded data (NOT including the 0x00 delimiter).
// `dst` must be at least src_len bytes. Returns decoded byte count.
size_t cobs_decode(const uint8_t *src, size_t src_len, uint8_t *dst);
