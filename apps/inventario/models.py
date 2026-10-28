"""Productos e inventario.

Las existencias (StockQuant) nunca se editan a mano: solo cambian al
confirmar un movimiento (StockMove), así cada entrada, salida, traslado o
ajuste queda registrado con quién, cuándo y por qué. Ver services.py.
"""
from decimal import Decimal

from django.conf import settings
from django.db import models

from apps.core.models import TimeStampedModel


class UnitOfMeasure(TimeStampedModel):
    name = models.CharField('nombre', max_length=80)
    active = models.BooleanField('activa', default=True)

    class Meta:
        verbose_name = 'unidad de medida'
        verbose_name_plural = 'unidades de medida'
        ordering = ['name']

    def __str__(self):
        return self.name


class ProductCategory(TimeStampedModel):
    name = models.CharField('nombre', max_length=120)
    parent = models.ForeignKey('self', null=True, blank=True, on_delete=models.PROTECT,
                               related_name='children', verbose_name='categoría padre')

    class Meta:
        verbose_name = 'categoría de producto'
        verbose_name_plural = 'categorías de producto'
        ordering = ['name']

    def __str__(self):
        return self.complete_name

    @property
    def complete_name(self):
        names, node, seen = [], self, set()
        while node is not None and node.pk not in seen:
            seen.add(node.pk)
            names.append(node.name)
            node = node.parent
        return ' / '.join(reversed(names))

    def ancestors_and_self(self):
        """Ids de esta categoría y de todas sus padres (para las reglas de
        listas de precios por categoría)."""
        ids, node = [], self
        while node is not None and node.pk not in ids:
            ids.append(node.pk)
            node = node.parent
        return ids


class Product(TimeStampedModel):
    TYPE_GOODS = 'goods'
    TYPE_SERVICE = 'service'
    TYPE_CHOICES = [
        (TYPE_GOODS, 'Bien (medicamento, insumo)'),
        (TYPE_SERVICE, 'Servicio'),
    ]

    name = models.CharField('nombre', max_length=300, db_index=True)
    code = models.CharField('código interno', max_length=64, blank=True, db_index=True)
    barcode = models.CharField('código de barras', max_length=64, blank=True)
    type = models.CharField('tipo', max_length=10, choices=TYPE_CHOICES, default=TYPE_GOODS)
    track_inventory = models.BooleanField(
        'controlar inventario', default=False,
        help_text='Lleva existencias por ubicación. Solo aplica a bienes.')
    track_lots = models.BooleanField(
        'controlar lotes', default=False,
        help_text='Pide lote (y caducidad) en cada movimiento.')
    category = models.ForeignKey(ProductCategory, null=True, blank=True, on_delete=models.PROTECT,
                                 related_name='products', verbose_name='categoría')
    uom = models.ForeignKey(UnitOfMeasure, null=True, blank=True, on_delete=models.PROTECT,
                            verbose_name='unidad de medida')
    clinica = models.ForeignKey('core.Clinica', null=True, blank=True, on_delete=models.PROTECT,
                                verbose_name='clínica', help_text='Vacío = disponible en todas las clínicas.')
    list_price = models.DecimalField('precio de venta', max_digits=14, decimal_places=2, default=Decimal('0'))
    standard_price = models.DecimalField('costo', max_digits=14, decimal_places=4, default=Decimal('0'))
    sale_ok = models.BooleanField('se puede vender', default=True)
    description = models.TextField('descripción', blank=True)
    active = models.BooleanField('activo', default=True)

    class Meta:
        verbose_name = 'producto'
        verbose_name_plural = 'productos'
        ordering = ['name']

    def __str__(self):
        return f'[{self.code}] {self.name}' if self.code else self.name

    @property
    def qty_available(self):
        """Existencia total en ubicaciones internas."""
        total = self.quants.filter(location__usage=Location.USAGE_INTERNAL).aggregate(
            total=models.Sum('quantity'))['total']
        return total or Decimal('0')


class Location(TimeStampedModel):
    """Ubicación de inventario. Solo las internas tienen existencias propias;
    las demás representan el origen/destino de un movimiento."""

    USAGE_INTERNAL = 'internal'
    USAGE_SUPPLIER = 'supplier'
    USAGE_PATIENT = 'patient'
    USAGE_ADJUSTMENT = 'adjustment'
    USAGE_SCRAP = 'scrap'
    USAGE_CHOICES = [
        (USAGE_INTERNAL, 'Interna (almacén, farmacia)'),
        (USAGE_SUPPLIER, 'Proveedor (entradas)'),
        (USAGE_PATIENT, 'Paciente / aplicación (salidas)'),
        (USAGE_ADJUSTMENT, 'Ajuste de inventario'),
        (USAGE_SCRAP, 'Merma / desecho'),
    ]

    name = models.CharField('nombre', max_length=120)
    usage = models.CharField('tipo', max_length=12, choices=USAGE_CHOICES, default=USAGE_INTERNAL)
    parent = models.ForeignKey('self', null=True, blank=True, on_delete=models.PROTECT,
                               related_name='children', verbose_name='ubicación padre')
    clinica = models.ForeignKey('core.Clinica', null=True, blank=True, on_delete=models.PROTECT,
                                related_name='ubicaciones', verbose_name='clínica',
                                help_text='Obligatoria en las internas (almacén/farmacia de esa clínica).')
    active = models.BooleanField('activa', default=True)

    class Meta:
        verbose_name = 'ubicación'
        verbose_name_plural = 'ubicaciones'
        ordering = ['name']

    def __str__(self):
        if self.parent_id:
            return f'{self.parent} / {self.name}'
        if self.clinica_id and self.usage == self.USAGE_INTERNAL:
            return f'{self.clinica} / {self.name}'
        return self.name

    @property
    def is_internal(self):
        return self.usage == self.USAGE_INTERNAL


class Lot(TimeStampedModel):
    product = models.ForeignKey(Product, on_delete=models.PROTECT, related_name='lots', verbose_name='producto')
    name = models.CharField('lote', max_length=80)
    expiration_date = models.DateField('caducidad', null=True, blank=True)

    class Meta:
        verbose_name = 'lote'
        verbose_name_plural = 'lotes'
        ordering = ['expiration_date', 'name']
        constraints = [models.UniqueConstraint(fields=['product', 'name'], name='uniq_lot_per_product')]

    def __str__(self):
        return f'{self.name} (cad. {self.expiration_date:%d/%m/%Y})' if self.expiration_date else self.name


class StockQuant(models.Model):
    """Existencia actual de un producto en una ubicación interna (y lote).
    La mantiene services.confirm_move — no se edita directo."""

    product = models.ForeignKey(Product, on_delete=models.PROTECT, related_name='quants', verbose_name='producto')
    location = models.ForeignKey(Location, on_delete=models.PROTECT, related_name='quants', verbose_name='ubicación')
    lot = models.ForeignKey(Lot, null=True, blank=True, on_delete=models.PROTECT, verbose_name='lote')
    quantity = models.DecimalField('cantidad', max_digits=14, decimal_places=4, default=Decimal('0'))
    updated_at = models.DateTimeField('actualizado', auto_now=True)

    class Meta:
        verbose_name = 'existencia'
        verbose_name_plural = 'existencias'
        # Dos restricciones parciales en vez de nulls_distinct=False (que pide
        # PostgreSQL 15+): una existencia por producto/ubicación sin lote, y
        # una por producto/ubicación/lote.
        constraints = [
            models.UniqueConstraint(fields=['product', 'location'], condition=models.Q(lot__isnull=True),
                                    name='uniq_quant_no_lot'),
            models.UniqueConstraint(fields=['product', 'location', 'lot'], condition=models.Q(lot__isnull=False),
                                    name='uniq_quant_lot'),
        ]

    def __str__(self):
        return f'{self.product} @ {self.location}: {self.quantity}'


class StockMove(TimeStampedModel):
    KIND_IN = 'in'
    KIND_OUT = 'out'
    KIND_INTERNAL = 'internal'
    KIND_ADJUSTMENT = 'adjustment'
    KIND_CHOICES = [
        (KIND_IN, 'Entrada'),
        (KIND_OUT, 'Salida'),
        (KIND_INTERNAL, 'Traslado interno'),
        (KIND_ADJUSTMENT, 'Ajuste'),
    ]
    STATE_DRAFT = 'draft'
    STATE_DONE = 'done'
    STATE_CANCEL = 'cancel'
    STATE_CHOICES = [
        (STATE_DRAFT, 'Pendiente'),
        (STATE_DONE, 'Hecho'),
        (STATE_CANCEL, 'Cancelado'),
    ]

    reference = models.CharField('referencia', max_length=80, blank=True,
                                 help_text='Folio, factura del proveedor, cita…')
    product = models.ForeignKey(Product, on_delete=models.PROTECT, related_name='moves', verbose_name='producto')
    quantity = models.DecimalField('cantidad', max_digits=14, decimal_places=4)
    location_from = models.ForeignKey(Location, on_delete=models.PROTECT, related_name='moves_out',
                                      verbose_name='origen')
    location_to = models.ForeignKey(Location, on_delete=models.PROTECT, related_name='moves_in',
                                    verbose_name='destino')
    lot = models.ForeignKey(Lot, null=True, blank=True, on_delete=models.PROTECT, verbose_name='lote')
    kind = models.CharField('tipo', max_length=12, choices=KIND_CHOICES, editable=False)
    state = models.CharField('estado', max_length=8, choices=STATE_CHOICES, default=STATE_DRAFT, db_index=True)
    date = models.DateTimeField('fecha', null=True, blank=True, help_text='Se llena al confirmar.')
    partner_name = models.CharField('contacto', max_length=200, blank=True,
                                    help_text='Proveedor o paciente, como texto libre por ahora.')
    note = models.TextField('nota', blank=True)
    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL,
                                   related_name='+', verbose_name='creado por')
    done_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL,
                                related_name='+', verbose_name='confirmado por')

    class Meta:
        verbose_name = 'movimiento de inventario'
        verbose_name_plural = 'movimientos de inventario'
        ordering = ['-created_at']
        constraints = [
            models.CheckConstraint(condition=models.Q(quantity__gt=0), name='move_quantity_positive'),
            models.CheckConstraint(condition=~models.Q(location_from=models.F('location_to')),
                                   name='move_distinct_locations'),
        ]

    def __str__(self):
        return f'{self.get_kind_display()} {self.reference or self.pk}: {self.product} x {self.quantity}'

    @staticmethod
    def kind_for(location_from, location_to):
        internal_from, internal_to = location_from.is_internal, location_to.is_internal
        if internal_from and internal_to:
            return StockMove.KIND_INTERNAL
        if location_from.usage == Location.USAGE_ADJUSTMENT or location_to.usage == Location.USAGE_ADJUSTMENT:
            return StockMove.KIND_ADJUSTMENT
        if internal_to:
            return StockMove.KIND_IN
        return StockMove.KIND_OUT

    def save(self, *args, **kwargs):
        if self.location_from_id and self.location_to_id:
            self.kind = self.kind_for(self.location_from, self.location_to)
        super().save(*args, **kwargs)
