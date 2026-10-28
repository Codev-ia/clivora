from django.contrib import admin

from .models import Cita, CitaArchivo, MotivoCita, MotivoRechazo


@admin.register(MotivoCita)
class MotivoCitaAdmin(admin.ModelAdmin):
    list_display = ('name', 'tipo', 'active')
    list_filter = ('tipo', 'active')


@admin.register(MotivoRechazo)
class MotivoRechazoAdmin(admin.ModelAdmin):
    list_display = ('name', 'active')


class CitaArchivoInline(admin.TabularInline):
    model = CitaArchivo
    extra = 0
    readonly_fields = ('nombre', 'mimetype', 'tamano', 'created_at', 'created_by')


@admin.register(Cita)
class CitaAdmin(admin.ModelAdmin):
    list_display = ('inicio', 'tipo', 'paciente', 'doctor', 'lugar', 'sala', 'estado', 'clinica')
    list_filter = ('clinica', 'tipo', 'estado', 'lugar')
    search_fields = ('paciente__nombre_completo', 'paciente__expediente', 'solicitante_nombre')
    date_hierarchy = 'inicio'
    inlines = [CitaArchivoInline]
    raw_id_fields = ('paciente',)
