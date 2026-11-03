// Where registration lookups are sent. When the page runs on your own machine it
// uses the local server; everywhere else it uses the hosted API on Netlify.
const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname);

window.TRIPXYZ_CONFIG = {
  apiBase: isLocal ? '' : 'https://tripxyz.netlify.app/',
};
