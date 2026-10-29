from rest_framework import serializers

from apps.core.clinica import active_clinica, allowed_clinicas

from .models import Location, Lot, Product, ProductCategory, StockMove, StockQuant, UnitOfMeasure


class UnitOfMeasureSerializer(serializers.ModelSerializer):
    class Meta:
        model = UnitOfMeasure
        fields = ['id', 'name', 'active']


class ProductCategorySerializer(serializers.ModelSerializer):
    complete_name = serializers.CharField(read_only=True)

    class Meta:
        model = ProductCategory
        fields = ['id', 'name', 'parent', 'complete_name']


class ProductSerializer(serializers.ModelSerializer):
    qty_available = serializers.SerializerMethodField()
    category_name = serializers.CharField(source='category.complete_name', read_only=True, default='')
    uom_name = serializers.CharField(source='uom.name', read_only=True, default='')
    clinica_name = serializers.CharField(source='clinica.name', read_only=True, default='')

    class Meta:
        model = Product
        fields = ['id', 'name', 'code', 'barcode', 'type', 'track_inventory', 'track_lots', 'category',
                  'category_name', 'uom', 'uom_name', 'clinica', 'clinica_name', 'list_price', 'standard_price', 'sale_ok', 'description', 'active', 'qty_available']

    def get_qty_available(self, obj):
        # La lista la trae anotada (una sola consulta); el detalle la calcula.
        value = getattr(obj, 'qty_internal', None)
        return str(value if value is not None else obj.qty_available)

    def validate_clinica(self, value):
        if value and not allowed_clinicas(self.context['request'].user).filter(pk=value.pk).exists():
            raise serializers.ValidationError('No tienes acceso a esa clínica.')
        return value

    def validate(self, attrs):
        ptype = attrs.get('type', getattr(self.instance, 'type', Product.TYPE_GOODS))
        if ptype == Product.TYPE_SERVICE and attrs.get('track_inventory'):
            raise serializers.ValidationError({'track_inventory': 'Un servicio no lleva inventario.'})
        return attrs


class LocationSerializer(serializers.ModelSerializer):
    display_name = serializers.CharField(source='__str__', read_only=True)
    usage_label = serializers.CharField(source='get_usage_display', read_only=True)

    class Meta:
        model = Location
        fields = ['id', 'name', 'display_name', 'usage', 'usage_label', 'parent', 'clinica', 'active']


class LotSerializer(serializers.ModelSerializer):
    class Meta:
        model = Lot
        fields = ['id', 'product', 'name', 'expiration_date']


class StockQuantSerializer(serializers.ModelSerializer):
    product_name = serializers.CharField(source='product.name', read_only=True)
    product_code = serializers.CharField(source='product.code', read_only=True)
    uom_name = serializers.CharField(source='product.uom.name', read_only=True, default='')
    location_name = serializers.CharField(source='location.__str__', read_only=True)
    lot_name = serializers.CharField(source='lot.name', read_only=True, default='')
    expiration_date = serializers.DateField(source='lot.expiration_date', read_only=True, default=None)

    class Meta:
        model = StockQuant
        fields = ['id', 'product', 'product_name', 'product_code', 'uom_name', 'location', 'location_name', 'lot',
                  'lot_name', 'expiration_date', 'quantity', 'updated_at']


class StockMoveSerializer(serializers.ModelSerializer):
    product_name = serializers.CharField(source='product.name', read_only=True)
    product_code = serializers.CharField(source='product.code', read_only=True)
    location_from_name = serializers.CharField(source='location_from.__str__', read_only=True)
    location_to_name = serializers.CharField(source='location_to.__str__', read_only=True)
    lot_name = serializers.CharField(source='lot.name', read_only=True, default='')
    kind_label = serializers.CharField(source='get_kind_display', read_only=True)
    state_label = serializers.CharField(source='get_state_display', read_only=True)
    done_by_name = serializers.SerializerMethodField()

    class Meta:
        model = StockMove
        fields = ['id', 'reference', 'product', 'product_name', 'product_code', 'quantity', 'location_from',
                  'location_from_name', 'location_to', 'location_to_name', 'lot', 'lot_name', 'kind', 'kind_label',
                  'state', 'state_label', 'date', 'partner_name', 'note', 'created_by', 'done_by', 'done_by_name',
                  'created_at']
        read_only_fields = ['kind', 'state', 'date', 'created_by', 'done_by', 'created_at']

    def get_done_by_name(self, obj):
        return (obj.done_by.get_full_name() or obj.done_by.username) if obj.done_by_id else ''

    def validate(self, attrs):
        clinica = active_clinica(self.context['request'])
        for key in ('location_from', 'location_to'):
            loc = attrs.get(key)
            if loc and loc.is_internal and loc.clinica_id != getattr(clinica, 'pk', None):
                raise serializers.ValidationError({key: 'La ubicación no es de la clínica activa.'})
        if self.instance and self.instance.state != StockMove.STATE_DRAFT:
            raise serializers.ValidationError('Un movimiento hecho o cancelado ya no se modifica.')
        src = attrs.get('location_from', getattr(self.instance, 'location_from', None))
        dst = attrs.get('location_to', getattr(self.instance, 'location_to', None))
        if src and dst and src == dst:
            raise serializers.ValidationError('Origen y destino deben ser distintos.')
        return attrs


class StockAdjustmentSerializer(serializers.Serializer):
    product = serializers.PrimaryKeyRelatedField(queryset=Product.objects.all())
    location = serializers.PrimaryKeyRelatedField(queryset=Location.objects.filter(usage=Location.USAGE_INTERNAL))

    def validate_location(self, value):
        if value.clinica_id != getattr(active_clinica(self.context['request']), 'pk', None):
            raise serializers.ValidationError('La ubicación no es de la clínica activa.')
        return value
    lot = serializers.PrimaryKeyRelatedField(queryset=Lot.objects.all(), required=False, allow_null=True)
    counted_quantity = serializers.DecimalField(max_digits=14, decimal_places=4, min_value=0)
    note = serializers.CharField(required=False, allow_blank=True)
