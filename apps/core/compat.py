"""Rutas de Farmacia que consume el frontend (app.js): productos,
existencias, listas de precios, aseguradoras y el resumen de farmacia.
"""
import datetime

from django.contrib.auth.decorators import login_required
from django.db.models import Q
from django.http import JsonResponse
from django.utils import timezone
from django.views.decorators.http import require_GET

from apps.core.clinica import active_clinica, shared_or_active
from apps.inventario.models import Location, Product, StockMove, StockQuant
from apps.precios.models import Aseguradora, Pricelist

# Mismas etiquetas que _PICKING_STATE_LABELS de Clivora.
MOVE_STATE_LABELS = {
    StockMove.STATE_DRAFT: 'Borrador',
    StockMove.STATE_DONE: 'Hecho',
    StockMove.STATE_CANCEL: 'Cancelado',
}
MOVE_KIND_LABELS = {StockMove.KIND_IN: 'Entrada', StockMove.KIND_OUT: 'Salida'}


def _json(data):
    return JsonResponse(data, safe=False, json_dumps_params={'ensure_ascii': False})


@require_GET
@login_required
def products(request):
    """Datalist de Medicamentos/Esquemas: [{id, name}], 50 máximo."""
    q = request.GET.get('q', '')
    qs = Product.objects.filter(shared_or_active(request), active=True)
    if q:
        qs = qs.filter(name__icontains=q)
    return _json([{'id': p.pk, 'name': p.name} for p in qs.order_by('name')[:50]])


@require_GET
@login_required
def products_stock(request):
    """Grid de "Agregar productos" de Tratamientos, 80 máximo."""
    q = request.GET.get('q', '')
    qs = Product.objects.filter(shared_or_active(request), active=True, sale_ok=True)
    if q:
        qs = qs.filter(Q(name__icontains=q) | Q(code__icontains=q))
    qs = list(qs.order_by('name')[:80])
    stock = {}
    for row in (StockQuant.objects.filter(product__in=qs, location__usage=Location.USAGE_INTERNAL,
                                          location__clinica=active_clinica(request))
                .values('product_id', 'quantity')):
        stock[row['product_id']] = stock.get(row['product_id'], 0) + row['quantity']
    return _json([{
        'id': p.pk, 'name': p.name, 'code': p.code,
        'qtyAvailable': float(stock.get(p.pk, 0)), 'price': float(p.list_price),
    } for p in qs])


@require_GET
@login_required
def pricelists(request):
    qs = Pricelist.objects.filter(shared_or_active(request), active=True)
    return _json([{'id': p.pk, 'name': p.name} for p in qs])


@require_GET
@login_required
def aseguradoras(request):
    return _json([{'id': a.pk, 'name': a.name} for a in Aseguradora.objects.filter(active=True)])


@require_GET
@login_required
def farmacia_summary(request):
    today = timezone.localdate()
    month_start = timezone.make_aware(datetime.datetime.combine(today.replace(day=1), datetime.time.min))
    moves = StockMove.objects.filter(Q(location_from__clinica=active_clinica(request)) | Q(location_to__clinica=active_clinica(request)))
    done_month = moves.filter(state=StockMove.STATE_DONE, date__gte=month_start)
    pending = moves.filter(state=StockMove.STATE_DRAFT)
    recientes = moves.select_related('product').order_by('-created_at')[:10]
    return _json({
        'entradasMes': done_month.filter(kind=StockMove.KIND_IN).count(),
        'salidasMes': done_month.filter(kind=StockMove.KIND_OUT).count(),
        'entradasPendientes': pending.filter(kind=StockMove.KIND_IN).count(),
        'salidasPendientes': pending.filter(kind=StockMove.KIND_OUT).count(),
        'existenciasConStock': StockQuant.objects.filter(
            quantity__gt=0, location__usage=Location.USAGE_INTERNAL, location__clinica=active_clinica(request)).count(),
        'movimientos': [{
            'tipo': MOVE_KIND_LABELS.get(m.kind, 'Interno'),
            'referencia': m.reference or f'MOV/{m.pk}',
            'contacto': m.partner_name,
            'fecha': timezone.localtime(m.date or m.created_at).date().isoformat(),
            'estado': MOVE_STATE_LABELS.get(m.state, m.state),
        } for m in recientes],
    })
