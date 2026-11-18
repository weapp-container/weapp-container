/** Pure conflict-checked input identity union, shared by the driver and official runner. */
const require = (condition, message) => { if (!condition) throw new Error(message) }
/** The union contains each frozen path once, in first-use order. A shared
 * dependency must retain the same reviewed identity in every case. */
export function uniqueCollectorInputs(references) {
  const inputs = new Map()
  for (const { path, sha256, bytes } of references) {
    require(bytes === undefined || Number.isSafeInteger(bytes) && bytes >= 0,
      `Native collector input size is invalid for ${path}`)
    const previous = inputs.get(path)
    require(!previous || previous.sha256 === sha256
      && (previous.bytes === undefined || bytes === undefined || previous.bytes === bytes),
    `Native collector input identity conflicts for ${path}`)
    if (!previous) inputs.set(path, { path, sha256, ...(bytes === undefined ? {} : { bytes }) })
    else if (bytes !== undefined) previous.bytes = bytes
  }
  return [...inputs.values()]
}

