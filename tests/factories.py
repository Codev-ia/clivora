from decimal import Decimal

from apps.core.models import Clinica
from apps.inventario.models import Location, Product, ProductCategory


def clinica(name='Clínica Demo', **kw):
    return Clinica.objects.create(name=name, **kw)


def product(name='Paracetamol', **kw):
    defaults = dict(type=Product.TYPE_GOODS, track_inventory=True, list_price=Decimal('100'),
                    standard_price=Decimal('40'))
    defaults.update(kw)
    return Product.objects.create(name=name, **defaults)


def location(name='Farmacia', usage=Location.USAGE_INTERNAL, clinica=None):
    return Location.objects.create(name=name, usage=usage, clinica=clinica)


def category(name, parent=None):
    return ProductCategory.objects.create(name=name, parent=parent)
