from decimal import Decimal

from django.test import TestCase

from apps.precios.models import Pricelist, PricelistItem
from apps.precios.pricing import get_price

from . import factories as f


class PreciosTests(TestCase):
    def setUp(self):
        self.prod = f.product()  # precio de venta 100
        self.otro = f.product('Ondansetrón', list_price=Decimal('50'))
        self.base = Pricelist.objects.create(name='Base')
        PricelistItem.objects.create(pricelist=self.base, product=self.prod, price=Decimal('200'))

    def test_sin_lista_o_sin_precio_usa_precio_de_venta(self):
        self.assertEqual(get_price(None, self.prod), Decimal('100'))
        self.assertEqual(get_price(Pricelist.objects.create(name='Vacía'), self.prod), Decimal('100'))

    def test_precio_propio(self):
        self.assertEqual(get_price(self.base, self.prod), Decimal('200.00'))

    def test_lista_base_y_descuento(self):
        gnp = Pricelist.objects.create(name='GNP', base_pricelist=self.base, base_discount=Decimal('10'))
        self.assertEqual(get_price(gnp, self.prod), Decimal('180.00'))       # de la base, -10%
        self.assertEqual(get_price(gnp, self.otro), Decimal('45.00'))        # ni la base lo tiene: venta -10%
        PricelistItem.objects.create(pricelist=gnp, product=self.prod, price=Decimal('150'))
        self.assertEqual(get_price(gnp, self.prod), Decimal('150.00'))       # el propio gana

    def test_cadena_de_listas(self):
        medio = Pricelist.objects.create(name='Medio', base_pricelist=self.base)
        final = Pricelist.objects.create(name='Final', base_pricelist=medio)
        self.assertEqual(get_price(final, self.prod), Decimal('200.00'))
