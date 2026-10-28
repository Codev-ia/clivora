from decimal import Decimal

from django.core.exceptions import ValidationError as DjangoValidationError
from django.db.models import DecimalField, Q, Sum, Value
from django.db.models.functions import Coalesce
from rest_framework import mixins, status, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import ValidationError
from rest_framework.response import Response

from apps.core.clinica import active_clinica, shared_or_active
from apps.core.permissions import ModelPermissions

from . import services
from .models import Location, Lot, Product, ProductCategory, StockMove, StockQuant, UnitOfMeasure
from .serializers import (LocationSerializer, LotSerializer, ProductCategorySerializer, ProductSerializer,
                          StockAdjustmentSerializer, StockMoveSerializer, StockQuantSerializer,
                          UnitOfMeasureSerializer)


def _drf_error(exc):
    return ValidationError({'detail': exc.messages})


class BaseViewSet(viewsets.ModelViewSet):
    permission_classes = [ModelPermissions]


class UnitOfMeasureViewSet(BaseViewSet):
    queryset = UnitOfMeasure.objects.filter(active=True)
    serializer_class = UnitOfMeasureSerializer
    pagination_class = None


class ProductCategoryViewSet(BaseViewSet):
    queryset = ProductCategory.objects.select_related('parent')
    serializer_class = ProductCategorySerializer
    pagination_class = None


class ProductViewSet(BaseViewSet):
    """Productos. Filtros: ?q= (nombre, código o código de barras), ?type=,
    ?category=, ?track_inventory=1, ?active=0 (por defecto solo activos)."""

    serializer_class = ProductSerializer

    def get_queryset(self):
        qs = Product.objects.select_related('category__parent', 'uom').annotate(qty_internal=Coalesce(
            Sum('quants__quantity', filter=Q(quants__location__usage=Location.USAGE_INTERNAL,
                                             quants__location__clinica=active_clinica(self.request))),
            Value(Decimal('0')), output_field=DecimalField(max_digits=14, decimal_places=4)))
        p = self.request.query_params
        # Productos de la clínica activa más los compartidos (sin clínica).
        qs = qs.filter(shared_or_active(self.request))
        qs = qs.filter(active=p.get('active', '1') not in ('0', 'false'))
        if p.get('q'):
            q = p['q'].strip()
            qs = qs.filter(Q(name__icontains=q) | Q(code__icontains=q) | Q(barcode=q))
        if p.get('type'):
            qs = qs.filter(type=p['type'])
        if p.get('category'):
            qs = qs.filter(category_id=p['category'])
        if p.get('track_inventory') in ('1', 'true'):
            qs = qs.filter(track_inventory=True)
        return qs

    def destroy(self, request, *args, **kwargs):
        # Con historial (movimientos o reglas de precio) no se borra: se archiva.
        product = self.get_object()
        product.active = False
        product.save(update_fields=['active', 'updated_at'])
        return Response(status=status.HTTP_204_NO_CONTENT)


class LocationViewSet(BaseViewSet):
    serializer_class = LocationSerializer
    pagination_class = None  # pocas: se usan completas en los selectores

    def get_queryset(self):
        # Internas de la clínica activa + las de paso (proveedor, paciente,
        # ajustes, merma), que no pertenecen a ninguna clínica.
        qs = Location.objects.select_related('parent').filter(active=True).filter(
            Q(clinica=active_clinica(self.request)) | ~Q(usage=Location.USAGE_INTERNAL))
        if self.request.query_params.get('usage'):
            qs = qs.filter(usage=self.request.query_params['usage'])
        return qs


class LotViewSet(BaseViewSet):
    serializer_class = LotSerializer
    pagination_class = None

    def get_queryset(self):
        qs = Lot.objects.all()
        if self.request.query_params.get('product'):
            qs = qs.filter(product_id=self.request.query_params['product'])
        return qs


class StockQuantViewSet(mixins.ListModelMixin, mixins.RetrieveModelMixin, viewsets.GenericViewSet):
    """Existencias actuales (solo lectura). Filtros: ?product=, ?location=,
    ?expiring_before=AAAA-MM-DD (lotes por caducar)."""

    permission_classes = [ModelPermissions]
    serializer_class = StockQuantSerializer

    def get_queryset(self):
        qs = StockQuant.objects.select_related('product', 'location__parent', 'lot').exclude(quantity=0).filter(
            location__clinica=active_clinica(self.request))
        p = self.request.query_params
        if p.get('q'):
            q = p['q'].strip()
            qs = qs.filter(Q(product__name__icontains=q) | Q(product__code__icontains=q) | Q(lot__name__icontains=q))
        if p.get('product'):
            qs = qs.filter(product_id=p['product'])
        if p.get('location'):
            qs = qs.filter(location_id=p['location'])
        if p.get('expiring_before'):
            qs = qs.filter(lot__expiration_date__lte=p['expiring_before'])
        return qs.order_by('product__name', 'location__name')


class StockMoveViewSet(BaseViewSet):
    """Movimientos. Se crean pendientes y se confirman con
    POST /movimientos/<id>/confirmar/ (ahí cambian las existencias)."""

    serializer_class = StockMoveSerializer

    def get_queryset(self):
        qs = StockMove.objects.select_related('product', 'location_from__parent', 'location_to__parent', 'lot',
                                              'done_by').filter(Q(location_from__clinica=active_clinica(self.request))
                                                                | Q(location_to__clinica=active_clinica(self.request)))
        p = self.request.query_params
        for field in ('state', 'kind', 'product'):
            if p.get(field):
                qs = qs.filter(**{field: p[field]})
        if p.get('q'):
            q = p['q'].strip()
            qs = qs.filter(Q(reference__icontains=q) | Q(product__name__icontains=q) | Q(product__code__icontains=q)
                           | Q(partner_name__icontains=q))
        return qs

    def perform_create(self, serializer):
        serializer.save(created_by=self.request.user)

    def get_serializer_context(self):
        return {**super().get_serializer_context(), 'request': self.request}

    def perform_destroy(self, instance):
        if instance.state != StockMove.STATE_DRAFT:
            raise ValidationError({'detail': 'Solo se borran movimientos pendientes.'})
        instance.delete()

    @action(detail=True, methods=['post'], url_path='confirmar')
    def confirm(self, request, pk=None):
        try:
            move = services.confirm_move(self.get_object(), user=request.user)
        except DjangoValidationError as exc:
            raise _drf_error(exc)
        return Response(self.get_serializer(move).data)

    @action(detail=True, methods=['post'], url_path='cancelar')
    def cancel(self, request, pk=None):
        try:
            move = services.cancel_move(self.get_object())
        except DjangoValidationError as exc:
            raise _drf_error(exc)
        return Response(self.get_serializer(move).data)

    @action(detail=False, methods=['post'], url_path='ajuste')
    def adjustment(self, request):
        """Conteo físico: deja la existencia de producto/ubicación/lote en la cantidad contada."""
        data = StockAdjustmentSerializer(data=request.data, context={'request': request})
        data.is_valid(raise_exception=True)
        v = data.validated_data
        try:
            move = services.set_quantity(v['product'], v['location'], v['counted_quantity'], lot=v.get('lot'),
                                         user=request.user, note=v.get('note', ''))
        except DjangoValidationError as exc:
            raise _drf_error(exc)
        if move is None:
            return Response({'detail': 'Sin diferencia: la existencia ya coincide.'})
        return Response(self.get_serializer(move).data, status=status.HTTP_201_CREATED)
