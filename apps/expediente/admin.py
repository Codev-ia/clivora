from django.contrib import admin

from .models import (ArchivoPaciente, DiagnosticoCIE, DiagnosticoNotaOncologia, HistoriaClinica, MedicamentoAplicado, NotaEnfermeria,
                     LineaReceta, NotaOncologia, OrdenMedica, Pronostico, Receta, RecetaNotaOncologia,
                     RespuestaValoracion, SignosVitales, SignoVitalEnfermeria)


@admin.register(Pronostico)
class PronosticoAdmin(admin.ModelAdmin):
    list_display = ('name', 'sequence', 'active')
    list_editable = ('sequence', 'active')


@admin.register(DiagnosticoCIE)
class DiagnosticoCIEAdmin(admin.ModelAdmin):
    list_display = ('codigo', 'nombre', 'catalogo', 'capitulo', 'active')
    list_filter = ('catalogo', 'active')
    search_fields = ('codigo', 'nombre', 'sinonimos')


@admin.register(HistoriaClinica)
class HistoriaClinicaAdmin(admin.ModelAdmin):
    list_display = ('paciente', 'updated_at', 'updated_by')
    search_fields = ('paciente__nombre_completo', 'paciente__expediente')
    raw_id_fields = ('paciente',)
    readonly_fields = ('created_at', 'created_by', 'updated_at', 'updated_by')


@admin.register(SignosVitales)
class SignosVitalesAdmin(admin.ModelAdmin):
    list_display = ('paciente', 'created_at', 'sistolica', 'diastolica', 'fc', 'temperatura', 'created_by')
    raw_id_fields = ('paciente',)
    readonly_fields = ('superficie_corporal', 'imc', 'created_at', 'created_by', 'updated_at', 'updated_by')


class RespuestaValoracionInline(admin.TabularInline):
    model = RespuestaValoracion
    extra = 0


class SignoVitalEnfermeriaInline(admin.TabularInline):
    model = SignoVitalEnfermeria
    extra = 0


class MedicamentoAplicadoInline(admin.TabularInline):
    model = MedicamentoAplicado
    extra = 0


@admin.register(NotaEnfermeria)
class NotaEnfermeriaAdmin(admin.ModelAdmin):
    list_display = ('paciente', 'tipo', 'created_at', 'created_by')
    list_filter = ('tipo',)
    raw_id_fields = ('paciente',)
    readonly_fields = ('created_at', 'created_by', 'updated_at', 'updated_by')
    inlines = [RespuestaValoracionInline, SignoVitalEnfermeriaInline, MedicamentoAplicadoInline]


class DiagnosticoNotaOncologiaInline(admin.TabularInline):
    model = DiagnosticoNotaOncologia
    extra = 0
    raw_id_fields = ('cie',)


class RecetaNotaOncologiaInline(admin.TabularInline):
    model = RecetaNotaOncologia
    extra = 0


@admin.register(NotaOncologia)
class NotaOncologiaAdmin(admin.ModelAdmin):
    list_display = ('paciente', 'created_at', 'medico', 'created_by')
    raw_id_fields = ('paciente',)
    readonly_fields = ('created_at', 'created_by', 'updated_at', 'updated_by')
    inlines = [DiagnosticoNotaOncologiaInline, RecetaNotaOncologiaInline]


class LineaRecetaInline(admin.TabularInline):
    model = LineaReceta
    extra = 0


@admin.register(Receta)
class RecetaAdmin(admin.ModelAdmin):
    list_display = ('paciente', 'tipo', 'created_at', 'medico', 'created_by')
    list_filter = ('tipo',)
    raw_id_fields = ('paciente', 'nota_oncologia')
    readonly_fields = ('created_at', 'created_by', 'updated_at', 'updated_by')
    inlines = [LineaRecetaInline]


@admin.register(OrdenMedica)
class OrdenMedicaAdmin(admin.ModelAdmin):
    list_display = ('paciente', 'created_at', 'medico', 'created_by')
    raw_id_fields = ('paciente', 'nota_oncologia')
    readonly_fields = ('created_at', 'created_by', 'updated_at', 'updated_by')


@admin.register(ArchivoPaciente)
class ArchivoPacienteAdmin(admin.ModelAdmin):
    list_display = ('titulo', 'tipo', 'paciente', 'created_at', 'created_by', 'eliminado')
    list_filter = ('tipo', 'eliminado')
    search_fields = ('titulo', 'paciente__nombre_completo', 'paciente__expediente')
    raw_id_fields = ('paciente',)
    readonly_fields = ('created_at', 'created_by', 'updated_at', 'updated_by', 'mimetype', 'tamano')
