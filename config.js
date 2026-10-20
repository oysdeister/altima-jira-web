// Configuración pública de la versión web (no hay secretos: el client secret de Atlassian vive solo en el Worker).
// Rellena los valores vacíos al terminar los pasos de ARQUITECTURA.md (apartado 6) y haz push: Pages se republica sola.
window.ALTIMA_WEB = {
  cloudId: '497c0898-e333-4e39-9026-00ff678e617d',
  atlassianClientId: '',        // Client ID de la app de developer.atlassian.com
  redirectUri: 'https://oysdeister.github.io/altima-jira-web/',
  proxyUrl: '',                 // URL del Worker de Cloudflare, sin barra final
  jiraViaProxy: false,
  googleClientId: '',           // Client ID web de Google Cloud Console
  storeIssue: '',               // clave de la incidencia que guarda equipo, pase y vacaciones (p. ej. PROJ-1)
};
