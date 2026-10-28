"""Saneado del HTML que manda el editor de texto enriquecido de Clivora.

El frontend pinta estos textos con innerHTML: se dejan solo las etiquetas y
estilos que produce la barra de herramientas (fuente, tamaño, negritas,
colores, alineación, listas) y se quita todo lo demás (scripts, eventos,
enlaces, imágenes…).
"""
import nh3

_TAGS = {'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'font', 'span', 'div', 'p', 'br', 'ul', 'ol', 'li'}
_ATTRS = {'*': {'style'}, 'font': {'face', 'size', 'color'}}
_STYLES = {'color', 'background-color', 'font-family', 'font-size', 'font-weight', 'font-style',
           'text-align', 'text-decoration', 'text-decoration-line', 'text-decoration-color'}


def limpiar(valor):
    if not valor:
        return ''
    return nh3.clean(str(valor), tags=_TAGS, attributes=_ATTRS, filter_style_properties=_STYLES,
                     link_rel=None).strip()
