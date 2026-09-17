// Amount customization applies ONLY to the tip catalog product.
function resolve(product, cents) {
  if (product.type !== 'tip') return product;
  if (!Number.isSafeInteger(cents) || cents < product.minCents || cents > product.maxCents) throw Object.assign(new Error('Informe um mimo de R$ 5,00 a R$ 10.000,00, com até duas casas decimais.'), {status:400});
  return {...product, price:cents/100};
}
module.exports={resolve};
