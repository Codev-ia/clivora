from rest_framework import serializers

from apps.core.clinica import allowed_clinicas

from .models import Aseguradora, Pricelist, PricelistItem


class AseguradoraSerializer(serializers.ModelSerializer):
    class Meta:
        model = Aseguradora
        fields = ['id', 'name', 'rfc', 'active']


class PricelistSerializer(serializers.ModelSerializer):
    aseguradora_name = serializers.CharField(source='aseguradora.name', read_only=True, default='')
    clinica_name = serializers.CharField(source='clinica.name', read_only=True, default='')
    base_pricelist_name = serializers.CharField(source='base_pricelist.name', read_only=True, default='')
    items_count = serializers.IntegerField(read_only=True, default=0)

    class Meta:
        model = Pricelist
        fields = ['id', 'name', 'clinica', 'clinica_name', 'aseguradora', 'aseguradora_name', 'base_pricelist',
                  'base_pricelist_name', 'base_discount', 'currency', 'active', 'items_count']

    def validate_clinica(self, value):
        if value and not allowed_clinicas(self.context['request'].user).filter(pk=value.pk).exists():
            raise serializers.ValidationError('No tienes acceso a esa clínica.')
        return value

    def validate(self, attrs):
        base = attrs.get('base_pricelist', getattr(self.instance, 'base_pricelist', None))
        node, seen = base, {getattr(self.instance, 'pk', None)}
        while node is not None:
            if node.pk in seen:
                raise serializers.ValidationError({'base_pricelist': 'La lista base no puede depender de esta lista.'})
            seen.add(node.pk)
            node = node.base_pricelist
        return attrs


class PricelistItemSerializer(serializers.ModelSerializer):
    product_name = serializers.CharField(source='product.name', read_only=True)
    product_code = serializers.CharField(source='product.code', read_only=True)
    list_price = serializers.DecimalField(source='product.list_price', max_digits=14, decimal_places=2,
                                          read_only=True)

    class Meta:
        model = PricelistItem
        fields = ['id', 'pricelist', 'product', 'product_name', 'product_code', 'list_price', 'price']
        validators = []  # el duplicado se explica mejor en validate()

    def validate(self, attrs):
        pricelist = attrs.get('pricelist', getattr(self.instance, 'pricelist', None))
        product = attrs.get('product', getattr(self.instance, 'product', None))
        dup = PricelistItem.objects.filter(pricelist=pricelist, product=product)
        if self.instance:
            dup = dup.exclude(pk=self.instance.pk)
        if dup.exists():
            raise serializers.ValidationError({'product': 'Ese producto ya tiene precio en esta lista.'})
        return attrs
