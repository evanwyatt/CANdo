#include "cobs.h"

size_t cobs_decode(const uint8_t *src, size_t src_len, uint8_t *dst) {
    if (src_len == 0) return 0;
    size_t out = 0, i = 0;
    while (i < src_len) {
        uint8_t code = src[i++];
        for (uint8_t j = 1; j < code; j++) {
            if (i >= src_len) break;
            dst[out++] = src[i++];
        }
        if (code < 0xFF && i < src_len) dst[out++] = 0x00;
    }
    return out;
}

size_t cobs_encode(const uint8_t *src, size_t src_len, uint8_t *dst) {
    size_t out  = 0;
    size_t code = out++;  // position of the overhead byte
    uint8_t  run = 1;     // distance to next 0x00 (1 = this position is a zero)

    for (size_t i = 0; i < src_len; i++) {
        if (src[i] == 0x00) {
            dst[code] = run;
            code = out++;
            run  = 1;
        } else {
            dst[out++] = src[i];
            run++;
            if (run == 0xFF) {
                // Block of 254 non-zero bytes — emit overhead and restart
                dst[code] = run;
                code = out++;
                run  = 1;
            }
        }
    }

    dst[code]   = run;
    dst[out++]  = 0x00;  // frame delimiter
    return out;
}
