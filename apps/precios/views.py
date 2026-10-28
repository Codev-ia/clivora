from django.db.models import Count, Q
from django.shortcuts import get_object_or_404
from rest_framework import viewsets
from rest_framework.decorators import api_view, permission_classes
from rest_framework.exceptions import ValidationError
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from apps.core.clinica import shared_or_active
from apps.core.permissions import ModelPermissions
from apps.inventario.models import Product

from .models import Aseguradora, Pricelist, PricelistItem
from .pricing import get_price
from .serializers import AseguradoraSerializer, PricelistItemSerializer, PricelistSerializer


class AseguradoraViewSet(viewsets.ModelViewSet):
    permission_classes = [ModelPermissions]
    queryset = Aseguradora.objects.all()
    serializer_class = AseguradoraSerializer
    pagination_class = None


class PricelistViewSet(viewsets.ModelViewSet):
    """Listas de la clínica activa y las compartidas. Filtros: ?q=,
    ?aseguradora=, ?active=0|all. No se borran: se archivan."""

    permission_classes = [ModelPermissions]
    serializer_class = PricelistSerializer
    http_method_names = ['get', 'post', 'patch', 'head', 'options']

    def get_queryset(self):
        qs = (Pricelist.objects.filter(shared_or_active(self.request))
              .select_related('clinica', 'aseguradora', 'base_pricelist').annotate(items_count=Count('items')))
        p = self.request.query_params
        active = p.get('active', '1')
        if active != 'all':
            qs = qs.filter(active=active not in ('0', 'false'))
        if p.get('q'):
            qs = qs.filter(Q(name__icontains=p['q']) | Q(aseguradora__name__icontains=p['q']))
        if p.get('aseguradora'):
            qs = qs.filter(aseguradora_id=p['aseguradora'])
        return qs


class PricelistItemViewSet(viewsets.ModelViewSet):
    """Precios de producto de una lista: ?pricelist=<id> (obligatorio para listar), ?q=."""

    permission_classes = [ModelPermissions]
    serializer_class = PricelistItemSerializer

    def get_queryset(self):
        qs = PricelistItem.objects.select_related('product').filter(
            pricelist__in=Pricelist.objects.filter(shared_or_active(self.request)))
        p = self.request.query_params
        if self.action == 'list':
            if not p.get('pricelist'):
                raise ValidationError({'pricelist': 'Indique la lista de precios.'})
            qs = qs.filter(pricelist_id=p['pricelist'])
            if p.get('q'):
                qs = qs.filter(Q(product__name__icontains=p['q']) | Q(product__code__icontains=p['q']))
        return qs


@api_view(['GET'])
@permission_classes([IsAuthenticated])
def compute_price(request):
    """GET /api/v1/precios/calcular/?pricelist=<id>&product=<id>"""
    p = request.query_params
    product = get_object_or_404(Product, pk=p.get('product'))
    pricelist = None
    if p.get('pricelist'):
        pricelist = get_object_or_404(Pricelist.objects.filter(shared_or_active(request)), pk=p['pricelist'])
    return Response({'product': product.pk, 'pricelist': pricelist.pk if pricelist else None,
                     'price': str(get_price(pricelist, product)), 'list_price': str(product.list_price)})
