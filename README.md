# Altima Jira · versión web

Panel de tickets (CAU-TIC, DEIS, pase semanal, horas, reuniones) para usar fuera de claude.ai.

- Enlace: https://oysdeister.github.io/altima-jira-web/
- Se publica sola con GitHub Pages (Settings → Pages → *Deploy from a branch*, `main` / raíz) en cada push.
- `dashboard-artifact.html` es la misma fuente que el artefacto de claude.ai; `adapter.js` sustituye los conectores
  de claude.ai por las API de Jira, Google Calendar y Gmail; `index.html` carga las tres piezas.
- El equipo, sus correos y los destinatarios del pase **no** están en el código: se cargan una vez desde la propia
  página (botón «Cargar equipo.json») y se guardan en Jira.
- Para conectarla a Jira hay que dar de alta la app de Atlassian, el proxy (`worker/`) y la app de Google y rellenar
  `config.js`: pasos en [ARQUITECTURA.md](ARQUITECTURA.md), apartado 6.
