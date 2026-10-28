from django.contrib import admin, messages
from django.core.exceptions import ValidationError

from . import services
from .models import Location, Lot, Product, ProductCategory, StockMove, StockQuant, UnitOfMeasure


@admin.register(UnitOfMeasure)
class UnitOfMeasureAdmin(admin.ModelAdmin):
    list_display = ('name', 'active')
    search_fields = ('name',)


@admin.register(ProductCategory)
class ProductCategoryAdmin(admin.ModelAdmin):
    list_display = ('complete_name', 'parent')
    search_fields = ('name',)
    autocomplete_fields = ('parent',)


class StockQuantInline(admin.TabularInline):
    model = StockQuant
    extra = 0
    can_delete = False
    fields = ('location', 'lot', 'quantity', 'updated_at')
    readonly_fields = fields

    def has_add_permission(self, request, obj=None):
        return False


@admin.register(Product)
class ProductAdmin(admin.ModelAdmin):
    list_display = ('name', 'code', 'type', 'category', 'list_price', 'qty_available', 'active')
    list_filter = ('type', 'track_inventory', 'sale_ok', 'active', 'clinica', 'category')
    search_fields = ('name', 'code', 'barcode')
    autocomplete_fields = ('category', 'uom')
    inlines = [StockQuantInline]
    fieldsets = (
        (None, {'fields': ('name', 'code', 'barcode', 'type', 'category', 'uom', 'clinica', 'active')}),
        ('Precios', {'fields': ('list_price', 'standard_price')}),
        ('Inventario', {'fields': ('track_inventory', 'track_lots')}),
        ('Uso', {'fields': ('sale_ok', 'description')}),
    )

    @admin.display(description='existencia')
    def qty_available(self, obj):
        return obj.qty_available.normalize() if obj.track_inventory else '—'


@admin.register(Location)
class LocationAdmin(admin.ModelAdmin):
    list_display = ('__str__', 'usage', 'clinica', 'active')
    list_filter = ('usage', 'clinica', 'active')
    search_fields = ('name',)


@admin.register(Lot)
class LotAdmin(admin.ModelAdmin):
    list_display = ('name', 'product', 'expiration_date')
    search_fields = ('name', 'product__name')
    autocomplete_fields = ('product',)
    date_hierarchy = 'expiration_date'


@admin.register(StockQuant)
class StockQuantAdmin(admin.ModelAdmin):
    list_display = ('product', 'location', 'lot', 'quantity', 'updated_at')
    list_filter = ('location',)
    search_fields = ('product__name', 'product__code', 'lot__name')

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    def has_delete_permission(self, request, obj=None):
        return False


@admin.register(StockMove)
class StockMoveAdmin(admin.ModelAdmin):
    list_display = ('created_at', 'kind', 'reference', 'product', 'quantity', 'location_from', 'location_to',
                    'state', 'done_by')
    list_filter = ('state', 'kind', 'location_from', 'location_to')
    search_fields = ('reference', 'product__name', 'product__code', 'partner_name')
    autocomplete_fields = ('product', 'lot', 'location_from', 'location_to')
    readonly_fields = ('kind', 'state', 'date', 'created_by', 'done_by')
    actions = ['action_confirm', 'action_cancel']

    def get_readonly_fields(self, request, obj=None):
        # Un movimiento hecho o cancelado ya no se edita (historial).
        if obj and obj.state != StockMove.STATE_DRAFT:
            return [f.name for f in self.model._meta.fields]
        return self.readonly_fields

    def save_model(self, request, obj, form, change):
        if not change:
            obj.created_by = request.user
        super().save_model(request, obj, form, change)

    def has_delete_permission(self, request, obj=None):
        return obj is None or obj.state == StockMove.STATE_DRAFT

    def _run(self, request, queryset, fn, ok_msg):
        done = 0
        for move in queryset:
            try:
                fn(move)
                done += 1
            except ValidationError as e:
                self.message_user(request, f'{move}: {"; ".join(e.messages)}', messages.ERROR)
        if done:
            self.message_user(request, ok_msg % done, messages.SUCCESS)

    @admin.action(description='Confirmar movimientos seleccionados')
    def action_confirm(self, request, queryset):
        self._run(request, queryset, lambda m: services.confirm_move(m, user=request.user),
                  '%d movimiento(s) confirmados.')

    @admin.action(description='Cancelar movimientos pendientes')
    def action_cancel(self, request, queryset):
        self._run(request, queryset, services.cancel_move, '%d movimiento(s) cancelados.')
