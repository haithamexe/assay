// Builds the one-file demo: src/style.css + src/data.js + src/app.js + the three fonts (embedded) -> index.html
// Run:  node build.mjs
import fs from 'node:fs';
import path from 'node:path';

const root = import.meta.dirname;
const src = path.join(root, 'src');
const read = f => fs.readFileSync(path.join(src, f), 'utf8');
const b64 = f => fs.readFileSync(path.join(src, 'fonts', f)).toString('base64');

const css = read('style.css')
  .replace('__GEIST_MONO__', () => b64('geist-mono.woff2'))
  .replace('__GEIST__', () => b64('geist.woff2'))
  .replace('__SILKSCREEN__', () => b64('silkscreen.woff2'));
const js = read('data.js') + '\n' + read('app.js');
if (js.includes('</script>')) throw new Error('the script contains </script>');

const html = read('shell.html')
  .replace('/*CSS*/', () => css)
  .replace('/*JS*/', () => js);
fs.writeFileSync(path.join(root, 'index.html'), html);
console.log('index.html', Math.round(html.length / 1024) + ' KB');
