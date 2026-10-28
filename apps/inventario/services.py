"""Reglas de inventario. Toda modificación de existencias pasa por aquí."""
from decimal import Decimal

from django.core.exceptions import ValidationError
from django.db import transaction
from django.utils import timezone

from .models import Location, StockMove, StockQuant


def _locked_quant(product, location, lot):
    """Existencia de producto/ubicación/lote bloqueada para escritura
    (select_for_update): dos confirmaciones simultáneas del mismo producto se
    forman en fila en vez de pisarse los totales."""
    quant = (StockQuant.objects.select_for_update()
             .filter(product=product, location=location, lot=lot).first())
    if quant is None:
        quant = StockQuant.objects.create(product=product, location=location, lot=lot, quantity=Decimal('0'))
        quant = StockQuant.objects.select_for_update().get(pk=quant.pk)
    return quant


def _validate(move):
    product = move.product
    if product.type != product.TYPE_GOODS or not product.track_inventory:
        raise ValidationError(f'"{product}" no controla inventario.')
    if product.track_lots and not move.lot_id:
        raise ValidationError(f'"{product}" requiere lote.')
    if move.lot_id and move.lot.product_id != product.pk:
        raise ValidationError('El lote no corresponde al producto.')


@transaction.atomic
def confirm_move(move, user=None, allow_negative=False):
    """Confirma un movimiento pendiente y actualiza las existencias de sus
    ubicaciones internas. Por defecto no permite dejar una ubicación interna
    en negativo."""
    move = StockMove.objects.select_for_update(of=('self',)).select_related(
        'product', 'location_from', 'location_to', 'lot').get(pk=move.pk)
    if move.state != StockMove.STATE_DRAFT:
        raise ValidationError('Solo se pueden confirmar movimientos pendientes.')
    _validate(move)

    if move.location_from.usage == Location.USAGE_INTERNAL:
        quant = _locked_quant(move.product, move.location_from, move.lot)
        if not allow_negative and quant.quantity < move.quantity:
            raise ValidationError(
                f'Existencia insuficiente de "{move.product}" en {move.location_from}: '
                f'hay {quant.quantity.normalize()}, se piden {move.quantity.normalize()}.')
        quant.quantity -= move.quantity
        quant.save(update_fields=['quantity', 'updated_at'])

    if move.location_to.usage == Location.USAGE_INTERNAL:
        quant = _locked_quant(move.product, move.location_to, move.lot)
        quant.quantity += move.quantity
        quant.save(update_fields=['quantity', 'updated_at'])

    move.state = StockMove.STATE_DONE
    move.date = timezone.now()
    move.done_by = user
    move.save(update_fields=['state', 'date', 'done_by', 'updated_at'])
    return move


@transaction.atomic
def cancel_move(move):
    """Cancela un movimiento pendiente. Uno ya hecho no se cancela: se
    corrige con un movimiento inverso, para no reescribir el historial."""
    move = StockMove.objects.select_for_update().get(pk=move.pk)
    if move.state != StockMove.STATE_DRAFT:
        raise ValidationError('Solo se pueden cancelar movimientos pendientes; '
                              'para corregir uno hecho, registre el movimiento inverso.')
    move.state = StockMove.STATE_CANCEL
    move.save(update_fields=['state', 'updated_at'])
    return move


def adjustment_location():
    location, _ = Location.objects.get_or_create(
        usage=Location.USAGE_ADJUSTMENT, parent=None,
        defaults={'name': 'Ajustes de inventario'})
    return location


@transaction.atomic
def set_quantity(product, location, counted_qty, lot=None, user=None, reference='Conteo físico', note=''):
    """Ajuste por conteo físico: deja la existencia en counted_qty generando
    el movimiento de ajuste (positivo o negativo) correspondiente."""
    if not location.is_internal:
        raise ValidationError('Solo se ajustan ubicaciones internas.')
    counted_qty = Decimal(counted_qty)
    current = (StockQuant.objects.filter(product=product, location=location, lot=lot)
               .values_list('quantity', flat=True).first()) or Decimal('0')
    diff = counted_qty - current
    if diff == 0:
        return None
    adj = adjustment_location()
    move = StockMove.objects.create(
        product=product, lot=lot, quantity=abs(diff), reference=reference, note=note,
        location_from=adj if diff > 0 else location,
        location_to=location if diff > 0 else adj,
        created_by=user,
    )
    return confirm_move(move, user=user, allow_negative=True)
