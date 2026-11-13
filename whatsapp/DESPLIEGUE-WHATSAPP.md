# WhatsApp con la API oficial de Meta (directo, sin terceros)

Arquitectura: Meta → (HTTPS) → servidor (Oracle) → `webhook.mjs` guarda en `data/whatsapp/mensajes.jsonl` →
el Despacho lee por ssh (solo lectura), registra cada conversación nueva como consulta y, **solo con el clic de la abogada**,
manda la respuesta con `enviar.mjs`. Un MCP propio (`legal-office/herramientas/whatsapp-mcp.mjs`) deja leer y proponer
borradores a los sectores; no puede enviar.

## Qué necesita Meta (lo hace la abogada)
1. **Portfolio comercial** en business.facebook.com. La verificación del negocio se pide para subir los límites de envío.
2. **App** en developers.facebook.com (tipo Business) con el producto **WhatsApp**. Eso crea la cuenta de WhatsApp Business (WABA).
3. **Un número que NO esté en ninguna app de WhatsApp** y pueda recibir un SMS o llamada con el código. Si ya está en WhatsApp o
   WhatsApp Business, hay que borrar esa cuenta antes. La coexistencia con la app solo se ofrece a través de partners de Meta.
4. **Usuario del sistema** (Configuración del negocio → Usuarios del sistema) con la app y la WABA asignadas con control total →
   generar un **token permanente** con los permisos `whatsapp_business_messaging` y `whatsapp_business_management`.
5. **Webhook** (WhatsApp → Configuración): URL `https://<subdominio>/whatsapp/webhook`, un *verify token* que elige ella, y suscribir el campo `messages`.
6. Datos que van al `.env` del servidor: `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_ID` (ID del número), `WHATSAPP_APP_SECRET` (Configuración de la app → Básica), `WHATSAPP_VERIFY_TOKEN`. **Nunca se los pasa a un chat: los carga ella en el servidor.**
7. Cambiar los botones de abogadasoledad.com para que abran WhatsApp con el número nuevo.

## Qué se hace en el servidor (con su OK, porque abre un puerto al público)
1. DNS: un registro A del subdominio (por ejemplo `wa.abogadasoledad.com`) a la IP del servidor.
2. Oracle Cloud: regla de entrada TCP 80 y 443 en la lista de seguridad de la red, y lo mismo en el firewall de la instancia.
3. Instalar Caddy (HTTPS automático) y reenviar **solo** la ruta `/whatsapp/webhook` a `127.0.0.1:8787`.
4. Servicio systemd `whatsapp-webhook` que corre `node whatsapp/webhook.mjs`. Rechaza todo POST sin firma válida (HMAC con el app secret).

## Límites de Meta a tener en cuenta
- Se puede responder con texto libre solo dentro de las **24 horas** del último mensaje del cliente; después, plantilla aprobada.
- El número en la API no se puede usar a la vez en la app del celular (sin coexistencia).
- Los precios y reglas de plantillas cambian: confirmar en la página oficial de precios de Meta.
