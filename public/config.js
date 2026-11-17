// Where registration lookups are sent. When the page runs on your own machine it
// uses the local server; everywhere else it uses the hosted API on Netlify.
const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname);

window.TRIPXYZ_CONFIG = {
  apiBase: isLocal ? '' : 'https://tripxyz.netlify.app/',

  // Google Maps JavaScript API key. This key is meant to be public: protect it by
  // restricting it to your site's address in Google Cloud. Leave empty to use OpenStreetMap.
  googleMapsKey: 'AIzaSyCVAbogxvs11wHyusOiS4p5Pz-GSy1IMbk',
  // Optional Map ID from Google Cloud (Map Management). DEMO_MAP_ID works for testing.
  googleMapId: '',
  // 'AUTO' matches the app's light or dark mode. 'DARK' or 'LIGHT' fixes it.
  mapColorScheme: 'AUTO',
};
