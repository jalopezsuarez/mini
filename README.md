# mini

**Escribe sin distracciones. Publica sin fricción.**

`mini` es un editor de Markdown minimalista para macOS. Pensado para quien necesita escribir bien, rápido y sin estorbos: notas, documentación, artículos, ideas. Una sola ventana, una sola fuente, una sola cosa que hacer — *escribir*.

---

## Por qué te va a gustar

- **Cero distracciones.** Sin barras laterales, sin ajustes infinitos, sin sorpresas. Solo tu texto.
- **Doble vista en un toque.** Pasa de Markdown plano a vista enriquecida con `⌘M`. La misma idea, dos formas de mirarla.
- **Atajos a la mano.** Negrita, cursiva, listas, encabezados, tablas, citas, código… todos los gestos que ya conoces, donde los esperas.
- **Tablas decentes de verdad.** Crear, añadir filas o columnas, eliminar — todo con teclado. Sin abrir un editor aparte.
- **Encabezados numerados automáticamente.** `⌘⇧H` para que tus secciones se enumeren solas (1., 1.1, 1.1.1…). Ideal para documentación técnica, manuales o informes.
- **Tu tipografía, tu estilo.** Suelta una fuente o un CSS en la carpeta `theme/` y `mini` la adopta. Sin tocar código.
- **Lánzalo desde la terminal.** Instala el comando `mini` con un clic y abre cualquier archivo con `mini notas.md`.
- **Nativo de macOS.** Doble clic en un `.md` desde Finder y se abre. Como cualquier app que respete su sitio.
- **Ligero.** Arranca rápido, ocupa poco, no pide cuentas, no llama a casa.

## Para quién es

- **Escritores y redactores** que quieren un lienzo limpio y un Markdown impecable.
- **Equipos técnicos** que documentan en `.md` y necesitan tablas, código y encabezados numerados sin pelear con el editor.
- **Estudiantes e investigadores** que toman apuntes en Markdown y exportan a donde haga falta.
- **Cualquiera cansado** de editores recargados que tardan más en abrir que en cerrar.

## Atajos esenciales

| Acción                       | Atajo       |
| ---------------------------- | ----------- |
| Cambiar vista (fuente/render) | `⌘M`        |
| Encabezado (cíclico)          | `⌘H`        |
| Encabezado numerado           | `⌘⇧H`       |
| Negrita / Cursiva / Subrayado | `⌘B` / `⌘I` / `⌘U` |
| Lista con viñetas / numerada  | `⌘L` / `⌘N` |
| Cita / Código                 | `⌘R` / `⌘F` |
| Línea horizontal              | `⌘P`        |
| Tabla (nueva o añadir fila)   | `⌘T`        |
| Borrar fila                   | `⌘⇧T`       |
| Añadir / quitar columna       | `⌘+` / `⌘-` |
| Aumentar / reducir fuente     | `⌘⇧+` / `⌘⇧-` |
| Abrir / Guardar / Guardar como | `⌘O` / `⌘S` / `⌘⇧S` |

---

## Sección técnica (para quien le interese)

`mini` es una app de escritorio para macOS construida con [Electron](https://www.electronjs.org/). El frontend es **vanilla JS** sin dependencias en tiempo de ejecución; toda la lógica del editor vive en `src/`.

### Estructura

```
mini/
├── main.js        Proceso principal de Electron (ventana, menús, IPC, CLI)
├── preload.js     Puente seguro entre main y renderer
├── src/           UI del editor (HTML, CSS, JS)
└── theme/         Fuentes y CSS personalizables por el usuario
```

### Requisitos

- macOS (Apple Silicon o Intel)
- Node.js 18+ y npm (solo para desarrollo)

### Desarrollo

```bash
npm install
npm start
```

### Empaquetar la app

```bash
# Solo Apple Silicon
npm run package

# Universal (Intel + Apple Silicon)
npm run package:universal
```

El bundle resultante queda en `dist/`.

### Comando `mini` en terminal

En el primer arranque, la app ofrece instalar `/usr/local/bin/mini` para lanzarla desde la consola:

```bash
mini                # abre la app
mini notas.md       # abre un archivo
```

---

## Personaliza tu mini

`mini` está pensado para que tú decidas cómo se ve. Toda la apariencia vive en la carpeta `theme/`, separada por completo del código de la app. Edita un par de archivos CSS, suelta una fuente, y listo — al reiniciar la app, los cambios se aplican.

> **Dónde está la carpeta `theme/`:**
> - En desarrollo: `theme/` en la raíz del proyecto.
> - En la app instalada: `/Applications/mini.app/Contents/Resources/app/theme/`
>   (clic derecho sobre `mini.app` → *Mostrar contenido del paquete*).

### Las dos vistas, dos temas

`mini` tiene dos vistas y cada una tiene su propio archivo de estilos. Así puedes darles personalidades distintas — por ejemplo, una mono y técnica para escribir, otra serif y elegante para leer.

| Archivo                  | Qué controla                                                       |
| ------------------------ | ------------------------------------------------------------------ |
| `theme/theme.source.css` | Vista **fuente** (Markdown plano, con resaltado de tokens).        |
| `theme/theme.editor.css` | Vista **editor** (Markdown renderizado: encabezados, citas, etc.). |

Los selectores que escribas en cada archivo se aplican **solo a su panel**. Las variables `:root` que definas también — no se mezclan entre vistas.

### Cambiar colores

Cada tema expone una paleta de variables CSS en `:root`. Edítalas y verás el cambio al instante (al reiniciar):

**`theme.source.css` — vista de código fuente**

```css
:root {
  --bg:        #252524;   /* fondo del panel */
  --fg:        #e7e5e2;   /* texto base */
  --fg-dim:    #8b8782;   /* texto atenuado, placeholder */
  --accent:    #c96442;   /* acento (caret, énfasis) */
  --selection: #3a3633;   /* color de selección */
  --caret:     #c96442;   /* color del cursor */
}
```

Y los **tokens de resaltado** (encabezados, listas, citas, código, énfasis):

```css
.hl-h  { color: #68ecec; }   /* # encabezados */
.hl-l  { color: #9fe872; }   /* - * + listas */
.hl-q  { color: #f27d86; }   /* > citas */
.hl-c  { color: #bc85f9; }   /* ` ``` código */
.hl-em { color: #fee383; }   /* **negrita** *cursiva* */
```

**`theme.editor.css` — vista renderizada**

```css
:root {
  --bg:        #1f1e1d;   /* fondo */
  --bg-soft:   #262624;   /* fondo de bloques (pre, th) */
  --bg-code:   #2a2826;   /* fondo de inline code */
  --fg:        #fafaf9;   /* texto */
  --fg-dim:    #8b8782;   /* texto secundario */
  --heading:   #fafaf9;   /* encabezados */
  --accent:    #c96442;   /* enlaces, marcadores, caret */
  --rule:      #3a3735;   /* bordes y separadores */
  --quote-bar: #c96442;   /* barra lateral de citas */
}
```

### Cambiar fuentes

**Paso 1 — añade el archivo.** Suelta cualquier `.ttf`, `.otf`, `.woff` o `.woff2` dentro de `theme/`. `mini` la registra automáticamente al arrancar usando el **nombre del archivo (sin extensión)** como `font-family`.

```
theme/
├── Inter.ttf            → font-family: 'Inter'
├── JetBrainsMono.ttf    → font-family: 'JetBrainsMono'
└── copernicus.ttf       → font-family: 'copernicus' (incluida por defecto)
```

**Paso 2 — úsala en el tema.** Cada CSS expone variables de tipografía:

```css
/* theme.source.css */
:root {
  --mono: 'JetBrainsMono', ui-monospace, "SF Mono", Menlo, monospace;
}

/* theme.editor.css */
:root {
  --serif: 'copernicus', ui-serif, serif;
  --sans:  'Inter', -apple-system, system-ui, sans-serif;
  --mono:  ui-monospace, "SF Mono", Menlo, monospace;
}
```

¿Necesitas varios pesos? Suelta `Inter-Regular.ttf` e `Inter-Bold.ttf` y agrúpalas en una sola familia con `@font-face`:

```css
@font-face {
  font-family: 'Inter';
  src: url('theme://Inter-Regular.ttf');
  font-weight: 400;
}
@font-face {
  font-family: 'Inter';
  src: url('theme://Inter-Bold.ttf');
  font-weight: 700;
}
```

> El esquema `theme://` apunta a tu carpeta `theme/`. Úsalo para enlazar fuentes, imágenes de fondo o cualquier asset desde el CSS.

### Tamaño, interlineado y detalles

Más allá de colores y fuentes, puedes ajustar cualquier propiedad CSS estándar:

```css
/* theme.editor.css */
html, body {
  font-size: 16px;        /* tamaño base */
  line-height: 1.8;       /* interlineado */
}

h1 { font-size: 2.2em; border-bottom: 2px solid var(--accent); }
blockquote { font-style: normal; border-left-width: 4px; }
pre { border-radius: 12px; }
```

En la vista de fuente puedes ajustar el espaciado entre caracteres, ligaduras, etc.:

```css
/* theme.source.css */
html, body {
  font-size: 14px;
  line-height: 1.7;
  letter-spacing: 0.01em;
  font-feature-settings: "liga" 1, "calt" 1;   /* activa ligaduras */
}
```

### Aplicar los cambios

Guarda los archivos y **reinicia `mini`** (`⌘Q` y vuelve a abrir). El tema se carga al arranque.

### Empezar de cero

Los archivos `theme.source.css` y `theme.editor.css` que vienen con la app son la mejor referencia: están comentados y muestran todas las variables disponibles. Cópialos, modifícalos, y rompe lo que quieras — siempre puedes volver al original.

---

## Licencia

Pendiente de definir.
