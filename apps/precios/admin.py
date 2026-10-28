from django.contrib import admin

from .models import Aseguradora, Pricelist, PricelistItem


@admin.register(Aseguradora)
class AseguradoraAdmin(admin.ModelAdmin):
    list_display = ('name', 'rfc', 'active')
    search_fields = ('name', 'rfc')


@admin.register(Pricelist)
class PricelistAdmin(admin.ModelAdmin):
    list_display = ('name', 'clinica', 'aseguradora', 'base_pricelist', 'active')
    list_filter = ('clinica', 'active')
    search_fields = ('name',)
    autocomplete_fields = ('aseguradora', 'base_pricelist')


@admin.register(PricelistItem)
class PricelistItemAdmin(admin.ModelAdmin):
    list_display = ('pricelist', 'product', 'price')
    search_fields = ('pricelist__name', 'product__name', 'product__code')
    autocomplete_fields = ('pricelist', 'product')
