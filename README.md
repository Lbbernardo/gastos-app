# Gastos operativos (Luis / Jefe)

Aplicación web **sin backend** para llevar gastos operativos y pagos entre Luis y su jefe. Los datos viven en `gastos.json` de este repositorio y se leen y escriben desde el navegador con la [GitHub Contents API](https://docs.github.com/en/rest/repos/contents).

**Repositorio:** https://github.com/Lbbernardo/gastos-app  
**Rama de trabajo:** `main`  
**Archivos en la raíz:** `index.html`, `app.js`, `gastos.json`, `README.md`

## Datos públicos a propósito

El repositorio es **público**. Cualquier persona puede ver:

- el archivo `gastos.json` (montos, fechas, categorías y descripciones);
- el historial de git, incluidos gastos o pagos que después se borren;
- el sitio de GitHub Pages, si está activo.

No hay cifrado ni control real de roles. No anotes secretos, contraseñas ni tokens en los gastos. Las etiquetas «Luis» y «Jefe» son solo el flujo de la pantalla.

## Qué hace

- **Luis** registra gastos: fecha, categoría, descripción y monto en USD.
- **Jefe** registra pagos: fecha, monto y **referencia obligatoria** al gasto que cubre.
- Los pagos parciales están permitidos. El estado de cada gasto es **pendiente**, **parcial** o **pagado**.
- Totales: gastos, pagos y saldo pendiente.
- Los montos se guardan en **centavos enteros**.
- Antes de cada cambio la app **vuelve a leer** el archivo y su `sha`. Si otra persona guardó antes (conflicto 409, o 422 porque el `sha` no coincide), **no sobrescribe y no reintenta sola**. Hay que recargar y repetir el cambio.
- Si `gastos.json` no existe pero el repositorio es accesible, se **crea** en el primer guardado.
- Un 404 al verificar el **repositorio** significa «no existe o este token no tiene acceso». GitHub no distingue esos dos casos.

## Lo que no es

- **No hay autenticación de roles.** Quien tenga Contents en el repo puede leer y escribir los mismos datos.
- **No hay base de datos ni sincronización en tiempo real.** Es un JSON compartido con control de `sha`.
- **No promete privacidad.** Un sitio de GitHub Pages también es público.
- **El token no va** en el código, en la URL, en los logs de la app ni en `gastos.json`. Solo vive en el campo de contraseña del navegador y, si pulsas «Guardar token», en `localStorage` de ese navegador (aviso de XSS y de equipo compartido).
- **Esta app no invita colaboradores ni cambia permisos.**

## Archivos

| Archivo        | Rol                                      |
|----------------|------------------------------------------|
| `index.html`   | Interfaz                                 |
| `app.js`       | Lógica, centavos, estados y Contents API |
| `gastos.json`  | Datos vacíos al publicar (`version`, `gastos`, `pagos`) |
| `README.md`    | Esta guía                                |

Esquema inicial, sin gastos de ejemplo:

```json
{
  "version": 1,
  "gastos": [],
  "pagos": []
}
```

## Token de cada persona

Luis y el jefe usan **tokens distintos**. Cada token es fine-grained y solo tiene **Contents: Read and write** de `Lbbernardo/gastos-app`.

El jefe solo puede crear ese token si su usuario de GitHub ya tiene acceso de escritura al repositorio. Dar ese acceso es un paso del dueño en GitHub (Settings → Collaborators). Esta publicación no envía invitaciones ni toca otros repositorios.

1. Entra a GitHub con **tu** usuario.
2. Abre [Fine-grained tokens](https://github.com/settings/personal-access-tokens/new).
3. Resource owner: tu usuario.
4. Repository access: **Only select repositories** → `Lbbernardo/gastos-app`.
5. Permissions → Repository permissions → **Contents**: **Read and write**.
6. No marques otros repositorios ni permisos de administración, secrets o Actions.
7. Genera el token y cópialo. GitHub solo lo muestra una vez.
8. En la app, pégalo en el campo de contraseña. No lo pongas en la barra de direcciones, en un issue ni en el chat.
9. Pulsa **Cargar datos remotos**.
10. Opcional: **Guardar token en este navegador**. No lo hagas en un equipo compartido. **Olvidar token** lo borra de este navegador.

Si el token pertenece a otro repo, la API responde 404 (sin acceso). Crea uno nuevo limitado a `gastos-app`.

La pestaña Red del navegador muestra la cabecera `Authorization` de tus propias llamadas. No compartas esa captura.

## Usar la app

1. Abre la URL de GitHub Pages si está publicada, o sirve esta carpeta con un servidor estático.
2. Revisa owner / repo / ruta / rama. Los valores iniciales son `Lbbernardo`, `gastos-app`, `gastos.json` y `main`.
3. Pega **tu** token y pulsa **Cargar datos remotos**.
4. Luis agrega gastos. El jefe registra pagos contra un gasto, parciales o por el restante exacto. No se puede pagar de más.
5. Si aparece **Conflicto**, otra escritura ganó. Recarga y vuelve a aplicar el cambio. Lo ya guardado por la otra persona sigue en el archivo.

**Guardar configuración** recuerda owner, repo, ruta y rama. No guarda el token. **Guardar token** es otro botón y pide confirmación.

## GitHub Pages

Ruta soportada: rama `main`, carpeta `/` (raíz).

URL: https://lbbernardo.github.io/gastos-app/

Pages solo entrega el HTML y el JS. Los datos siguen saliendo de la Contents API y hace falta el token de cada persona. El JSON público se puede leer igual sin abrir la app.

Si esa URL no responde, Pages no está activo. Activarlo exige permiso de administración: Settings → Pages → Deploy from a branch → Branch `main` → Folder `/ (root)`.

## Abrir como archivo local (`file://`)

Puede fallar: el origen `file://` y la política del navegador bloquean `fetch` hacia `api.github.com`. Mejor GitHub Pages o, en esta carpeta:

```bash
python3 -m http.server 8080
```

Luego abre `http://127.0.0.1:8080/`.

## Seguridad

- No pegues el token en issues, chats, la URL ni en `gastos.json`.
- La pantalla quita de la dirección parámetros o fragmentos que parezcan un token y no los copia al formulario.
- Cada GET usa `cache: no-store` para no reutilizar un `sha` viejo (la API cachea unos 60 segundos).
- La interfaz escribe texto con `textContent`. No usa `innerHTML` ni `eval` con los datos.
- Quien tenga Contents write puede cambiar o borrar el JSON. El historial público conserva lo anterior.
