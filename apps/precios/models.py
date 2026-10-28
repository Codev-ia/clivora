"""Aseguradoras y listas de precios.

Una lista tiene precios
fijos por producto y, opcionalmente, una lista base (con % de descuento)
para los productos que no tienen precio propio. Ver pricing.py.
"""
from decimal import Decimal

from django.core.exceptions import ValidationError
from django.core.validators import MaxValueValidator, MinValueValidator
from django.db import models

from apps.core.models import TimeStampedModel


class Aseguradora(TimeStampedModel):
    name = models.CharField('nombre', max_length=200)
    rfc = models.CharField('RFC', max_length=13, blank=True)
    active = models.BooleanField('activa', default=True)

    class Meta:
        verbose_name = 'aseguradora'
        verbose_name_plural = 'aseguradoras'
        ordering = ['name']

    def __str__(self):
        return self.name


class Pricelist(TimeStampedModel):
    name = models.CharField('nombre', max_length=200)
    clinica = models.ForeignKey('core.Clinica', null=True, blank=True, on_delete=models.PROTECT,
                                related_name='listas_precios', verbose_name='clínica',
                                help_text='Vacío = disponible en todas las clínicas.')
    aseguradora = models.ForeignKey(Aseguradora, null=True, blank=True, on_delete=models.PROTECT,
                                    related_name='pricelists', verbose_name='aseguradora')
    base_pricelist = models.ForeignKey('self', null=True, blank=True, on_delete=models.PROTECT,
                                       related_name='derived', verbose_name='lista base',
                                       help_text='Para los productos sin precio en esta lista.')
    base_discount = models.DecimalField('descuento sobre la lista base %', max_digits=5, decimal_places=2,
                                        default=Decimal('0'),
                                        validators=[MinValueValidator(0), MaxValueValidator(100)])
    currency = models.CharField('moneda', max_length=3, default='MXN')
    active = models.BooleanField('activa', default=True)

    class Meta:
        verbose_name = 'lista de precios'
        verbose_name_plural = 'listas de precios'
        ordering = ['name']

    def __str__(self):
        return self.name

    def clean(self):
        node, seen = self.base_pricelist, {self.pk}
        while node is not None:
            if node.pk in seen:
                raise ValidationError({'base_pricelist': 'La lista base no puede depender de esta misma lista.'})
            seen.add(node.pk)
            node = node.base_pricelist


class PricelistItem(TimeStampedModel):
    """Precio fijo de un producto en una lista."""

    pricelist = models.ForeignKey(Pricelist, on_delete=models.CASCADE, related_name='items',
                                  verbose_name='lista de precios')
    product = models.ForeignKey('inventario.Product', on_delete=models.CASCADE, related_name='pricelist_items',
                                verbose_name='producto')
    price = models.DecimalField('precio', max_digits=14, decimal_places=2, validators=[MinValueValidator(0)])

    class Meta:
        verbose_name = 'precio de producto'
        verbose_name_plural = 'precios de producto'
        ordering = ['product__name']
        constraints = [
            models.UniqueConstraint(fields=['pricelist', 'product'], name='uniq_precio_por_lista'),
        ]

    def __str__(self):
        return f'{self.pricelist}: {self.product} = {self.price}'
