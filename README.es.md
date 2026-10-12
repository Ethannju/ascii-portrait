# ASCII Portrait Studio

[English](./README.md) · [简体中文](./README.zh-CN.md) · [日本語](./README.ja.md) · **Español**

Convierte una foto en un retrato ASCII animado directamente en el navegador y
expórtalo como PNG o como un video de 6 segundos que se repite sin cortes. Tus
fotos nunca salen de tu dispositivo.

**[Pruébalo en línea →](https://ethannju.github.io/ascii-portrait/)**

https://github.com/user-attachments/assets/ceb3b831-9312-4d70-a9b9-8a16b6d99dea

<sub>[Video en alta calidad (1080p)](./media/ascii-portrait-demo.mp4)</sub>

## Ejemplos

| Retrato · Original color | Astronauta · Amber | Mecha · Cobalt |
| :-: | :-: | :-: |
| <img src="./assets/demo-portrait.jpg" width="260" alt="Original: retrato"> | <img src="./assets/demo-astronaut.jpg" width="260" alt="Original: astronauta"> | <img src="./assets/demo-mecha.jpg" width="260" alt="Original: mecha"> |
| <img src="./media/examples/portrait-ascii.webp" width="260" alt="ASCII: retrato"> | <img src="./media/examples/astronaut-ascii.webp" width="260" alt="ASCII: astronauta"> | <img src="./media/examples/mecha-ascii.webp" width="260" alt="ASCII: mecha"> |

Arriba, la imagen original; abajo, el resultado del Studio (cuadrícula 8, 19
niveles). Haz clic en una imagen para verla a tamaño completo. Las tres imágenes
originales son demos generadas con IA que vienen incluidas en el Studio
([procedencia](./assets/PROVENANCE.md)).

## Cómo funciona

1. **Brillo → caracteres.** La foto se muestrea en una cuadrícula. El brillo de
   cada celda elige un carácter de un conjunto de 19 o 27 niveles, de claro a
   denso, y el carácter conserva el color de la celda (o usa una paleta
   Monochrome, Signal green, Amber o Cobalt).
2. **Separación del retrato.** Un modelo de segmentación que se ejecuta en el
   navegador (TensorFlow.js, MediaPipe Selfie Segmentation) separa a la persona
   del fondo. Si no está disponible, se usa la foto completa.
3. **Desplazamiento y movimiento.** Un campo 2D derivado del brillo desplaza la
   imagen con WebGL y los caracteres se animan encima. No hay reconstrucción 3D.
4. **Exportación fotograma a fotograma.** Cada fotograma se renderiza sobre una
   línea de tiempo fija y se codifica con WebCodecs en un WebM de 24 fps que se
   repite sin cortes. En un equipo lento la exportación tarda más, pero no se
   pierde ningún fotograma.

## Uso

Abre el [Studio en línea](https://ethannju.github.io/ascii-portrait/) o ejecútalo
en local con Node.js 22 o superior (sin dependencias ni paso de compilación):

```bash
git clone https://github.com/Ethannju/ascii-portrait.git
cd ascii-portrait
npm run dev        # abre http://127.0.0.1:4173
```

1. Arrastra una foto o elige una muestra en **Demos**.
2. Ajusta el tamaño de la cuadrícula, el color, el desplazamiento y el movimiento
   en el Inspector.
3. Elige **PNG still** o **Looping video · 6s** y haz clic en **Export**.

La interfaz está disponible en inglés y chino (todavía no en español). Exportar
video requiere WebCodecs y se ha probado en Chrome 154 y Safari 26.4 en macOS; en
otros entornos, exporta un PNG. La separación del retrato descarga su modelo desde
un CDN la primera vez. Ejecuta `npm test` antes de contribuir cambios.

Tu última foto y tus ajustes se guardan solo en tu propio navegador, así que
vuelven a aparecer cuando abres la página de nuevo. No se sube nada, y los demás
visitantes siempre empiezan desde la pantalla inicial. Para borrarlos, haz clic en
**Clear local data**, en la sección **Scene** del Inspector.

### Cómo conseguir el mejor resultado

El Studio convierte en caracteres la luz y las sombras que ya tiene tu foto, así
que la foto importa más que cualquier ajuste. La mejor entrada es un **retrato con
iluminación de estudio, fondo negro y mucho contraste**: un lado de la cara muy
iluminado, el otro en sombra profunda y la cara ocupando buena parte del encuadre.
Los selfis con luz plana y los fondos recargados se convierten en ruido.

Si tu foto no es así, pide primero a una IA de generación de imágenes (por
ejemplo, ChatGPT o Gemini) que la vuelva a iluminar y sube el resultado. Ejemplo
de prompt:

> Convierte esta foto en un retrato de estudio en clave baja de la misma persona.
> Mantén sin cambios la cara, la identidad, el peinado y la expresión. Fondo negro
> puro y continuo. Una luz principal dura, de color blanco cálido, desde un lado y
> ligeramente por encima ilumina la frente, la nariz, el pómulo y la mandíbula de
> un lado; el otro lado de la cara queda en sombra profunda. Añade una luz de
> contorno fina y fría en el pelo y el hombro del lado oscuro. Encuadre de cabeza
> y hombros con la cara grande en el cuadro, formato vertical 4:5. Fotorrealista,
> ojos nítidos, textura de piel real y luces altas que conserven el detalle. Sin
> texto, accesorios ni marcas de agua.

Usa solo fotos tuyas o fotos que tengas permiso para usar.

## Licencia

Código: [MIT](./LICENSE). Imágenes de demostración y material multimedia:
[ASSET-LICENSE.md](./ASSET-LICENSE.md).
