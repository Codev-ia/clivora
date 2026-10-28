"""Catálogos del SAT usados en varias partes (clínicas, pacientes)."""

# Catálogo c_RegimenFiscal del SAT (CFDI 4.0).
REGIMENES_FISCALES = [
    ('601', 'General de Ley Personas Morales'),
    ('603', 'Personas Morales con Fines no Lucrativos'),
    ('605', 'Sueldos y Salarios e Ingresos Asimilados a Salarios'),
    ('606', 'Arrendamiento'),
    ('607', 'Régimen de Enajenación o Adquisición de Bienes'),
    ('608', 'Demás ingresos'),
    ('609', 'Consolidación'),
    ('610', 'Residentes en el Extranjero sin Establecimiento Permanente en México'),
    ('611', 'Ingresos por Dividendos (socios y accionistas)'),
    ('612', 'Personas Físicas con Actividades Empresariales y Profesionales'),
    ('614', 'Ingresos por intereses'),
    ('615', 'Régimen de los ingresos por obtención de premios'),
    ('616', 'Sin obligaciones fiscales'),
    ('620', 'Sociedades Cooperativas de Producción que optan por diferir sus ingresos'),
    ('621', 'Incorporación Fiscal'),
    ('622', 'Actividades Agrícolas, Ganaderas, Silvícolas y Pesqueras'),
    ('623', 'Opcional para Grupos de Sociedades'),
    ('624', 'Coordinados'),
    ('625', 'Régimen de las Actividades Empresariales con ingresos a través de Plataformas Tecnológicas'),
    ('626', 'Régimen Simplificado de Confianza - RESICO'),
    ('628', 'Hidrocarburos'),
    ('629', 'De los Regímenes Fiscales Preferentes y de las Empresas Multinacionales'),
    ('630', 'Enajenación de acciones en bolsa de valores'),
]
REGIMEN_CODES = {code for code, _ in REGIMENES_FISCALES}

# RFC: 12 caracteres persona moral, 13 persona física (formato SAT).
RFC_REGEX = r'^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$'
