const products = [
  {
    id: 'atlas',
    name: 'Atlas Carry Pack',
    category: 'Everyday carry',
    description: 'A compact day pack with a clean profile and room for the essentials.',
    price: 189,
    image: '/assets/products/atlas.png',
  },
  {
    id: 'halo',
    name: 'Halo Desk Light',
    category: 'Home studio',
    description: 'A soft, focused light for a late train ride or a quiet desk session.',
    price: 129,
    image: '/assets/products/halo.png',
  },
  {
    id: 'grid',
    name: 'Grid Field Notes',
    category: 'Paper goods',
    description: 'A sturdy pocket notebook for lists, sketches and the next good idea.',
    price: 39,
    image: '/assets/products/grid.png',
  },
]

function getProduct(id) {
  for (let index = 0; index < products.length; index += 1) {
    if (products[index].id === id) return products[index]
  }
  return null
}

module.exports = { products, getProduct }
