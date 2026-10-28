from django.contrib import admin

from .models import Clinica, Lugar, Sala, SystemSettings


class SalaInline(admin.TabularInline):
    model = Sala
    extra = 0


@admin.register(Clinica)
class ClinicaAdmin(admin.ModelAdmin):
    list_display = ('name', 'legal_name', 'rfc', 'city', 'active')
    search_fields = ('name', 'legal_name', 'rfc')


@admin.register(Lugar)
class LugarAdmin(admin.ModelAdmin):
    list_display = ('name', 'clinica', 'active')
    list_filter = ('clinica', 'active')
    inlines = [SalaInline]


@admin.register(SystemSettings)
class SystemSettingsAdmin(admin.ModelAdmin):
    list_display = ('__str__', 'max_usuarios', 'max_clinicas', 'updated_at')

    def has_add_permission(self, request):
        return not SystemSettings.objects.exists()

    def has_delete_permission(self, request, obj=None):
        return False
