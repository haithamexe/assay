/* Runs before the page paints, so the chosen theme never flashes. */
try {
  var t = localStorage.getItem('assay-theme');
  if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
} catch (e) { /* the system's theme applies */ }
