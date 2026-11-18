const STORAGE_KEY = 'shop-demo:cart'

function read() {
  const value = wx.getStorageSync(STORAGE_KEY)
  if (!Array.isArray(value)) return []
  return value.filter(item => item && typeof item.id === 'string' && Number(item.quantity) > 0)
    .map(item => ({ id: item.id, quantity: Math.max(1, Number(item.quantity)) }))
}

function write(items) {
  const next = items.filter(item => item.quantity > 0)
  wx.setStorageSync(STORAGE_KEY, next)
  return next
}

function add(id, amount) {
  const items = read()
  const count = Number(amount) || 1
  let found = false
  for (let index = 0; index < items.length; index += 1) {
    if (items[index].id === id) {
      items[index].quantity += count
      found = true
      break
    }
  }
  if (!found) items.push({ id, quantity: count })
  return write(items)
}

function setQuantity(id, quantity) {
  const items = read()
  for (let index = 0; index < items.length; index += 1) {
    if (items[index].id === id) items[index].quantity = Number(quantity)
  }
  return write(items)
}

function clear() {
  wx.removeStorageSync(STORAGE_KEY)
}

function count() {
  return read().reduce((total, item) => total + item.quantity, 0)
}

module.exports = { read, add, setQuantity, clear, count }
