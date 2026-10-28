"""Precio de un producto en una lista de precios.

1. Precio propio del producto en la lista.
2. Si no tiene, el de la lista base (menos su % de descuento), recursivo.
3. Si no hay lista o ninguna lo tiene, el precio de venta del producto.
"""
from decimal import ROUND_HALF_UP, Decimal

from .models import PricelistItem

MAX_DEPTH = 10  # corta ciclos accidentales entre listas base


def get_price(pricelist, product, _depth=0):
    if pricelist is None or _depth > MAX_DEPTH:
        return product.list_price
    price = (PricelistItem.objects.filter(pricelist=pricelist, product=product)
             .values_list('price', flat=True).first())
    if price is None:
        if pricelist.base_pricelist_id is None:
            return product.list_price
        price = get_price(pricelist.base_pricelist, product, _depth + 1)
        price = price * (1 - pricelist.base_discount / 100)
    return Decimal(price).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)
