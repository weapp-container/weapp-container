#include "weapp_container_sdk.h"
#include <cstring>
#include <stdexcept>
#include <vector>

// A C embedding library must not change exception matching in its C++ host.
// In particular, Skia's C shim must not supply private libc++ base RTTI.
int main() {
  if (weapp_container_sdk_abi_version() != 1 ||
      std::strlen(weapp_container_sdk_version()) == 0) return 1;
  int caught = 0;
  try { throw std::invalid_argument("host exception"); }
  catch (const std::exception&) { ++caught; }
  try {
    std::vector<int> values;
    values.resize(values.max_size() + 1);
  } catch (const std::exception&) { ++caught; }
  return caught == 2 ? 0 : 2;
}
