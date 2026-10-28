from django.contrib import admin

from .models import ExpedienteCompartido, OrigenReferencia, Paciente


@admin.register(OrigenReferencia)
class OrigenReferenciaAdmin(admin.ModelAdmin):
    list_display = ('name', 'pide_medico', 'active')


@admin.register(Paciente)
class PacienteAdmin(admin.ModelAdmin):
    list_display = ('expediente', 'nombre_completo', 'celular', 'email', 'clinica_registro', 'active')
    search_fields = ('expediente', 'nombre_completo', 'celular', 'email', 'rfc', 'curp')
    list_filter = ('active', 'clinica_registro', 'genero')
    readonly_fields = ('expediente', 'nombre_completo', 'created_at', 'updated_at')


@admin.register(ExpedienteCompartido)
class ExpedienteCompartidoAdmin(admin.ModelAdmin):
    list_display = ('paciente', 'medico', 'compartido_por', 'created_at')
    raw_id_fields = ('paciente',)
