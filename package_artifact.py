from pathlib import Path
import re,zipfile
root=Path(__file__).parent
html=(root/'dist/index.html').read_text(encoding='utf8')
js=next((root/'dist/assets').glob('*.js')).read_text(encoding='utf8')
css=next((root/'dist/assets').glob('*.css')).read_text(encoding='utf8')
html=re.sub(r'<script type="module"[^>]*src="[^"]+"[^>]*></script>','',html)
html=re.sub(r'<link rel="stylesheet"[^>]+>','',html)
html=html.replace('</head>','<style>'+css+'</style></head>').replace('</body>','<script type="module">'+js.replace('</script','<\\/script')+'</script></body>')
(root/'SLS-viewer.html').write_text(html,encoding='utf8')
with zipfile.ZipFile(root/'SLS-cel-model.zip','w',zipfile.ZIP_DEFLATED) as z:
 for path in root.rglob('*'):
  rel=path.relative_to(root)
  if not path.is_file() or any(v in rel.parts for v in ['node_modules','.git']):continue
  if rel.parts[0]=='reference' and path.name not in ['sls-nasa.jpg','livery-sources.json','nasa-worm.svg','nasa-insignia.svg','america250-logo.svg']:continue
  if path.suffix=='.zip' or path.name in ['debug.cjs','author_spec.py'] or path.name.startswith('pass-') or path.name.startswith('mark-') or path.name.startswith('skip-'):continue
  z.write(path,Path('SLS-cel-model')/rel)
print('Standalone viewer and source archive ready.')
