#pragma once

#include <cstdint>
#include <limits>
#include <string_view>

namespace weapp_container {
// ArkTS numbers cannot represent Unix nanoseconds exactly. Accept clocks and
// platform surface ids as decimal strings, without sign/whitespace/coercion.
inline bool ParseUint64(std::string_view text, uint64_t* output) {
    if (output == nullptr || text.empty()) return false;
    uint64_t value = 0;
    for (char character : text) {
        if (character < '0' || character > '9') return false;
        const auto digit = static_cast<uint64_t>(character - '0');
        if (value > (std::numeric_limits<uint64_t>::max() - digit) / 10) return false;
        value = value * 10 + digit;
    }
    *output = value;
    return true;
}
}  // namespace weapp_container
